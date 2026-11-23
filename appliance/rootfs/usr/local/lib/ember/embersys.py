#!/usr/bin/env python3
"""
Ember box - system helper. Runs as root, only from these systemd units:
  firstboot        grow the root partition to fill the SD card, fresh SSH keys and machine id (once)
  apply-config     apply ember-config.txt from the SD card's EMBER drive (Wi-Fi, name, time zone, SSH)
  hotspot-watch    start a Wi-Fi hotspot when the box has no network, so the laser can still be used (long-running)
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

SETUP_DIR = "/embersetup"
CONFIG_FILE = os.path.join(SETUP_DIR, "ember-config.txt")
STATE_DIR = "/var/lib/ember-sys"
SERVICE_USER = "ember"
WIFI_CON = "ember-wifi"
HOTSPOT_CON = "ember-hotspot"
HOTSPOT_PASSWORD = "ember1234"
ADMIN_USER = "emberadmin"


# ----------------------------------------------------------------------------- helpers
def run(cmd, check=False, timeout=60, input_text=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input_text)
    except (OSError, subprocess.TimeoutExpired) as e:
        if check:
            raise
        return subprocess.CompletedProcess(cmd, 1, "", str(e))
    if check and r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"{cmd[0]} failed")
    return r


def log(msg):
    print(f"ember: {msg}", file=sys.stderr, flush=True)


def out(obj):
    print(json.dumps(obj))


def nm_fields(line):
    """Split nmcli -t output (':' separated, '\\:' escaped)."""
    return [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]


def parse_config(path=CONFIG_FILE):
    cfg = {}
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line[0] in "#;[" or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                cfg[k.strip().lower()] = v
    except FileNotFoundError:
        pass
    return cfg


def truthy(v):
    return str(v).strip().lower() in ("1", "yes", "y", "on", "true", "enable", "enabled")


def wifi_device():
    r = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"])
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) >= 2 and f[1] == "wifi" and not f[0].startswith("p2p"):
            return f[0]
    return None


def ipv4_of(dev):
    r = run(["ip", "-4", "-o", "addr", "show", "dev", dev])
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", r.stdout)
    return m.group(1) if m else ""


def hotspot_active():
    r = run(["nmcli", "-t", "-f", "NAME", "connection", "show", "--active"])
    return HOTSPOT_CON in r.stdout.splitlines()


def network_ips():
    """IPv4 addresses on ethernet / normal Wi-Fi (not the setup hotspot)."""
    ips = []
    r = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"])
    for line in r.stdout.splitlines():
        f = nm_fields(line)
        if len(f) < 4 or f[1] not in ("ethernet", "wifi") or not f[2].startswith("connected") or f[3] == HOTSPOT_CON:
            continue
        ip = ipv4_of(f[0])
        if ip and not ip.startswith("10.42.") and not ip.startswith("169.254."):
            ips.append(ip)
    return ips


def hotspot_ssid():
    try:
        dev = wifi_device()
        mac = open(f"/sys/class/net/{dev}/address").read().strip().replace(":", "") if dev else ""
    except OSError:
        mac = ""
    return "Ember-Setup-" + (mac[-4:].upper() if mac else "Box")


def hostname():
    try:
        return open("/etc/hostname").read().strip()
    except OSError:
        return "ember"


# ----------------------------------------------------------------------------- first boot
def firstboot():
    os.makedirs(STATE_DIR, exist_ok=True)
    marker = os.path.join(STATE_DIR, "firstboot.done")
    if os.path.exists(marker):
        return
    try:
        src = run(["findmnt", "-n", "-o", "SOURCE", "/"]).stdout.strip()  # e.g. /dev/mmcblk0p1
        m = re.match(r"(/dev/(?:mmcblk\d+|nvme\d+n\d+|sd[a-z]+))p?(\d+)$", src)
        if m:
            disk, part = m.group(1), m.group(2)
            log(f"growing {src} to fill {disk}")
            run(["sfdisk", "--no-reread", "--no-tell-kernel", "-N", part, disk], input_text=", +\n")
            r = run(["partx", "-u", "--nr", part, disk])
            if r.returncode != 0:
                run(["resizepart", disk, part, str(int(run(["sfdisk", "--show-size", src]).stdout.strip() or 0))])
            run(["resize2fs", src], timeout=600)
        else:
            log(f"root device {src} not recognised, not resizing")
    except Exception as e:  # noqa: BLE001
        log(f"resize failed: {e}")
    if os.path.isdir("/etc/ssh"):
        for f in os.listdir("/etc/ssh"):
            if f.startswith("ssh_host_"):
                os.remove(os.path.join("/etc/ssh", f))
        run(["ssh-keygen", "-A"])
    try:
        if os.path.getsize("/etc/machine-id") == 0 or open("/etc/machine-id").read().strip() in ("", "uninitialized"):
            run(["systemd-machine-id-setup"])
    except OSError:
        run(["systemd-machine-id-setup"])
    open(marker, "w").write(time.strftime("%Y-%m-%d %H:%M:%S\n"))


# ----------------------------------------------------------------------------- SD card config
def apply_config():
    os.makedirs(STATE_DIR, exist_ok=True)
    cfg = parse_config()
    if not cfg:
        log("no ember-config.txt settings found")
        return
    fingerprint = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()
    stamp = os.path.join(STATE_DIR, "config.sha256")
    if os.path.exists(stamp) and open(stamp).read().strip() == fingerprint:
        log("ember-config.txt unchanged")
        return

    name = re.sub(r"[^a-z0-9-]", "", cfg.get("hostname", "").lower())[:32]
    if name:
        set_hostname(name)

    country = cfg.get("wifi_country", "").upper()
    if re.fullmatch(r"[A-Z]{2}", country):
        run(["iw", "reg", "set", country])
        try:
            with open("/etc/default/crda", "w") as f:
                f.write(f"REGDOMAIN={country}\n")
        except OSError:
            pass

    complete = True
    ssid = cfg.get("wifi_name") or cfg.get("wifi_ssid") or ""
    if ssid:
        for _ in range(30):  # the Wi-Fi driver can show up a little after NetworkManager
            if wifi_device():
                break
            time.sleep(1)
        r = wifi_configure(ssid, cfg.get("wifi_password", ""), hidden=truthy(cfg.get("wifi_hidden", "no")), connect=False)
        log(r.get("message", ""))
        complete = r.get("ok", False)

    tz = cfg.get("timezone", "")
    if tz and os.path.exists(f"/usr/share/zoneinfo/{tz}"):
        run(["timedatectl", "set-timezone", tz])

    ssh_pw = cfg.get("ssh_password", "")
    if truthy(cfg.get("ssh", "no")) and len(ssh_pw) >= 6:
        if run(["id", ADMIN_USER]).returncode != 0:
            run(["useradd", "-m", "-s", "/bin/bash", "-G", "sudo", ADMIN_USER])
        run(["chpasswd"], input_text=f"{ADMIN_USER}:{ssh_pw}\n")
        run(["systemctl", "enable", "--now", "ssh"])
        log(f"SSH enabled for user {ADMIN_USER}")
    elif "ssh" in cfg and not truthy(cfg.get("ssh")):
        run(["systemctl", "disable", "--now", "ssh"])

    if complete:
        with open(stamp, "w") as f:
            f.write(fingerprint)


# ----------------------------------------------------------------------------- Wi-Fi
def wifi_configure(ssid, password, hidden=False, connect=True, timeout=45):
    dev = wifi_device()
    if not dev:
        return {"ok": False, "message": "No Wi-Fi hardware found on this box."}
    run(["nmcli", "radio", "wifi", "on"])
    run(["nmcli", "connection", "delete", WIFI_CON])
    args = ["nmcli", "connection", "add", "type", "wifi", "con-name", WIFI_CON, "ifname", dev, "ssid", ssid,
            "connection.autoconnect", "yes", "connection.autoconnect-priority", "10", "802-11-wireless.powersave", "2"]
    if hidden:
        args += ["802-11-wireless.hidden", "yes"]
    if password:
        args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
    r = run(args)
    if r.returncode != 0:
        return {"ok": False, "message": "Could not save the Wi-Fi settings: " + (r.stderr or r.stdout).strip()}
    if not connect:
        return {"ok": True, "message": f"Wi-Fi \"{ssid}\" saved."}
    was_hotspot = hotspot_active()
    if was_hotspot:
        run(["nmcli", "connection", "down", HOTSPOT_CON])
        time.sleep(2)
    r = run(["nmcli", "--wait", str(timeout), "connection", "up", WIFI_CON], timeout=timeout + 15)
    if r.returncode == 0:
        time.sleep(2)
        return {"ok": True, "message": f"Connected to \"{ssid}\" ({ipv4_of(dev) or 'getting an address'}).", "ip": ipv4_of(dev)}
    msg = (r.stderr or r.stdout).strip()
    if "Secrets were required" in msg or "802-1x" in msg or "psk" in msg.lower():
        msg = "Wrong Wi-Fi password."
    elif "No network with SSID" in msg:
        msg = f"Network \"{ssid}\" not found. Check the name (upper/lower case matters) and that the router is in range."
    if was_hotspot:
        start_hotspot()
    return {"ok": False, "message": "Could not connect: " + msg}


def start_hotspot():
    dev = wifi_device()
    if not dev:
        return False
    run(["nmcli", "connection", "delete", HOTSPOT_CON])
    r = run(["nmcli", "connection", "add", "type", "wifi", "ifname", dev, "con-name", HOTSPOT_CON,
             "autoconnect", "no", "ssid", hotspot_ssid(), "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
             "ipv4.method", "shared", "ipv4.addresses", "10.42.0.1/24", "ipv6.method", "disabled",
             "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", HOTSPOT_PASSWORD])
    if r.returncode != 0:
        log("hotspot setup failed: " + r.stderr.strip())
        return False
    r = run(["nmcli", "--wait", "20", "connection", "up", HOTSPOT_CON], timeout=40)
    log("setup hotspot " + ("started: " + hotspot_ssid() if r.returncode == 0 else "failed: " + r.stderr.strip()))
    return r.returncode == 0


def hotspot_watch():
    """Starts the hotspot when the box has no network ~90 s after boot; while it runs, retries the saved
    Wi-Fi every 5 minutes. (The Ember server keeps MY-ACCESS-LINK.txt on the SD card up to date.)"""
    for _ in range(90):
        if network_ips():
            break
        time.sleep(1)
    last_retry = time.time()
    while True:
        try:
            ips = network_ips()
            if ips:
                if hotspot_active():
                    run(["nmcli", "connection", "down", HOTSPOT_CON])
            elif not hotspot_active():
                start_hotspot()
                last_retry = time.time()
            elif time.time() - last_retry > 300:
                last_retry = time.time()
                if run(["nmcli", "-t", "-f", "NAME", "connection", "show"]).stdout.count(WIFI_CON):
                    log("retrying saved Wi-Fi")
                    run(["nmcli", "connection", "down", HOTSPOT_CON])
                    time.sleep(2)
                    if run(["nmcli", "--wait", "30", "connection", "up", WIFI_CON], timeout=45).returncode != 0:
                        start_hotspot()
        except Exception as e:  # noqa: BLE001
            log(f"hotspot-watch: {e}")
        time.sleep(15)


# ----------------------------------------------------------------------------- USB drives
# ----------------------------------------------------------------------------- the update folder (Samba)
# ----------------------------------------------------------------------------- the server program itself
# ----------------------------------------------------------------------------- system
def set_hostname(name):
    name = re.sub(r"[^a-z0-9-]", "", name.lower())[:32]
    if not name:
        return {"ok": False, "message": "Use letters, numbers and dashes only."}
    run(["hostnamectl", "set-hostname", name])
    try:
        with open("/etc/hostname", "w") as f:
            f.write(name + "\n")
        hosts = open("/etc/hosts").read()
        hosts = re.sub(r"^127\.0\.1\.1\s+.*$", f"127.0.1.1\t{name}", hosts, flags=re.M)
        if "127.0.1.1" not in hosts:
            hosts += f"127.0.1.1\t{name}\n"
        open("/etc/hosts", "w").write(hosts)
    except OSError:
        pass
    run(["systemctl", "restart", "avahi-daemon"])
    return {"ok": True, "message": f"Renamed: the app is now at http://{name}.local"}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    try:
        if cmd == "firstboot":
            firstboot()
        elif cmd == "apply-config":
            apply_config()
        elif cmd == "hotspot-watch":
            hotspot_watch()
        else:
            out({"ok": False, "message": f"unknown command {cmd}"})
            sys.exit(2)
    except Exception as e:  # noqa: BLE001
        out({"ok": False, "message": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
