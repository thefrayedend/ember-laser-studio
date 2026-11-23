#!/bin/bash
# Runs INSIDE the board's root filesystem (chroot) during build-image.sh.
# Installs system packages and enables the services.
# The Ember server files themselves were already copied in by build-image.sh.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8

log() { echo "[customize] $*"; }

# ---------------------------------------------------------------- packages
log "Installing system packages"
# Vendor images point apt at their own mirrors (e.g. repo.huaweicloud.com), which are often
# slow, out of date or unreachable from the build server. For the build we use the official
# Debian/Ubuntu servers and put the vendor's settings back afterwards.
. /etc/os-release
CODENAME="${VERSION_CODENAME:-}"
APT_BAK=/tmp/apt-sources-backup
rm -rf "$APT_BAK"; mkdir -p "$APT_BAK"
cp -a /etc/apt/sources.list "$APT_BAK/" 2>/dev/null || true
[ -d /etc/apt/sources.list.d ] && cp -a /etc/apt/sources.list.d "$APT_BAK/" && rm -f /etc/apt/sources.list.d/*
restore_apt() {
  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true
  [ -f "$APT_BAK/sources.list" ] && cp -a "$APT_BAK/sources.list" /etc/apt/sources.list
  [ -d "$APT_BAK/sources.list.d" ] && cp -a "$APT_BAK/sources.list.d/." /etc/apt/sources.list.d/
  rm -rf "$APT_BAK"
}
trap restore_apt EXIT
PKGS="avahi-daemon libnss-mdns network-manager dnsmasq-base wpasupplicant iw rfkill wireless-regdb
  sudo python3 ca-certificates dosfstools fdisk e2fsprogs util-linux curl tzdata ffmpeg v4l-utils xz-utils"

# Writes /etc/apt/sources.list for one of several server choices.
set_sources() {
  if [ "${ID:-}" = ubuntu ]; then
    local M=http://ports.ubuntu.com/ubuntu-ports
    [ "$(dpkg --print-architecture)" = amd64 ] && M=http://archive.ubuntu.com/ubuntu
    case "$1" in
      full) printf 'deb %s %s main universe\ndeb %s %s-updates main universe\ndeb %s %s-security main universe\n' "$M" "$CODENAME" "$M" "$CODENAME" "$M" "$CODENAME" ;;
      base) printf 'deb %s %s main universe\n' "$M" "$CODENAME" ;;
      *) return 1 ;;
    esac > /etc/apt/sources.list
    return 0
  fi
  local SEC="$CODENAME-security"; [ "$CODENAME" = buster ] && SEC="buster/updates"
  local C="main contrib non-free"
  case "$1" in
    # 1) normal Debian servers incl. security updates
    full) printf 'deb http://deb.debian.org/debian %s %s\ndeb http://deb.debian.org/debian %s-updates %s\ndeb http://deb.debian.org/debian-security %s %s\n' \
            "$CODENAME" "$C" "$CODENAME" "$C" "$SEC" "$C" ;;
    # 2) old release whose security updates were moved: security from archive.debian.org
    mixed) printf 'deb http://deb.debian.org/debian %s %s\ndeb http://deb.debian.org/debian %s-updates %s\ndeb http://archive.debian.org/debian-security %s %s\n' \
            "$CODENAME" "$C" "$CODENAME" "$C" "$SEC" "$C" ;;
    # 3) snapshot.debian.org keeps every package version ever published (slow but complete)
    snapshot) printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260815T000000Z %s %s\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260815T000000Z %s-updates %s\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260815T000000Z %s %s\n' \
            "$CODENAME" "$C" "$CODENAME" "$C" "$SEC" "$C" ;;
    # 4) without security updates
    base) printf 'deb http://deb.debian.org/debian %s %s\ndeb http://deb.debian.org/debian %s-updates %s\n' "$CODENAME" "$C" "$CODENAME" "$C" ;;
    # 5) fully archived release
    archive) printf 'deb http://archive.debian.org/debian %s %s\ndeb http://archive.debian.org/debian-security %s %s\n' "$CODENAME" "$C" "$SEC" "$C" ;;
    *) return 1 ;;
  esac > /etc/apt/sources.list
}

INSTALLED=0
for choice in full mixed snapshot base archive; do
  set_sources "$choice" || continue
  log "Trying package servers: $choice (${ID:-?} $CODENAME)"
  rm -rf /var/lib/apt/lists/*   # drop stale lists from earlier attempts / the vendor mirror
  apt-get -o Acquire::Check-Valid-Until=false update || true
  # shellcheck disable=SC2086
  if apt-get install -y --no-install-recommends $PKGS; then
    INSTALLED=1
    break
  fi
  log "That didn't work, trying the next option"
done
[ "$INSTALLED" = 1 ] || { echo "[customize] ERROR: could not install the system packages from any package server"; exit 1; }
apt-get install -y --no-install-recommends openssh-server || true

# ---------------------------------------------------------------- Node.js (official build; the distro one is too old)
NODE_VERSION="${NODE_VERSION:-22.12.0}"
log "Installing Node.js $NODE_VERSION"
case "$(dpkg --print-architecture)" in arm64) NARCH=arm64 ;; amd64) NARCH=x64 ;; armhf) NARCH=armv7l ;; *) echo "[customize] ERROR: unsupported CPU"; exit 1 ;; esac
NODE_TAR="node-v${NODE_VERSION}-linux-${NARCH}.tar.xz"
cd /tmp
curl -fsSL --retry 5 -O "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
curl -fsSL --retry 5 -O "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " ${NODE_TAR}\$" SHASUMS256.txt | sha256sum -c - || { echo "[customize] ERROR: the Node.js download is corrupt"; exit 1; }
rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$NODE_TAR" -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
rm -f "$NODE_TAR" SHASUMS256.txt
node --version

# ---------------------------------------------------------------- user & folders
if ! id ember >/dev/null 2>&1; then
  log "Creating service user ember"
  useradd --system --home-dir /var/lib/ember --create-home --shell /usr/sbin/nologin ember
fi
# dialout: the laser's USB serial port. video: the webcam.
usermod -aG dialout,video ember
install -d -o ember -g ember -m 750 /var/lib/ember
install -d -m 755 /var/lib/ember-sys /embersetup
chown -R ember:ember /opt/ember
chown -R root:root /usr/local/lib/ember /etc/systemd/system/ember*.service /etc/NetworkManager/conf.d /etc/avahi/services /etc/systemd/journald.conf.d
chmod 755 /usr/local/sbin/ember-helper /usr/local/sbin/ember-rollback
python3 -m py_compile /usr/local/lib/ember/embersys.py

# ---------------------------------------------------------------- SD-card settings drive
if ! grep -q 'LABEL=EMBER' /etc/fstab; then
  log "Adding the EMBER settings drive to /etc/fstab"
  echo 'LABEL=EMBER /embersetup vfat defaults,nofail,uid=ember,gid=ember,fmask=0133,dmask=0022,flush,x-systemd.device-timeout=15s 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- hostname / mDNS
echo ember > /etc/hostname
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tember/' /etc/hosts
else
  printf '127.0.1.1\tember\n' >> /etc/hosts
fi
if grep -q '^hosts:' /etc/nsswitch.conf && ! grep -q mdns /etc/nsswitch.conf; then
  sed -i 's/^hosts:.*/hosts:          files mdns4_minimal [NOTFOUND=return] dns/' /etc/nsswitch.conf
fi

# ---------------------------------------------------------------- security defaults
# Vendor images ship well-known default passwords and SSH switched on. Lock them; SSH can be enabled from
# ember-config.txt with a personal password.
log "Locking default accounts and disabling SSH (enable it in ember-config.txt)"
passwd -l root >/dev/null 2>&1 || true
for u in $(awk -F: '$3 >= 1000 && $3 < 60000 {print $1}' /etc/passwd); do
  [ "$u" = ember ] || [ "$u" = emberadmin ] || passwd -l "$u" >/dev/null 2>&1 || true
done
systemctl disable ssh.service 2>/dev/null || true
systemctl disable sshd.service 2>/dev/null || true
rm -f /root/.not_logged_in_yet
rm -f /etc/systemd/system/serial-getty@*.service.d/override.conf /etc/systemd/system/getty@tty1.service.d/override.conf 2>/dev/null || true

# ---------------------------------------------------------------- services
for s in armbian-resize-filesystem orangepi-resize-filesystem resize2fs_once rpi-resizefs; do
  systemctl disable "$s.service" 2>/dev/null || true
  systemctl mask "$s.service" 2>/dev/null || true
done
systemctl enable NetworkManager.service avahi-daemon.service || true
systemctl enable ember-firstboot.service ember-config.service ember-hotspot.service ember.service
if [ -f /etc/network/interfaces ]; then
  sed -i -E '/^\s*(auto|allow-hotplug)\s+wlan[0-9]+/d; /^\s*iface\s+wlan[0-9]+/,/^\s*$/d' /etc/network/interfaces || true
fi

# ---------------------------------------------------------------- self-test (the build fails if any of this is wrong)
log "Self-test: the program starts under the service user"
[ -f /opt/ember/current/dist/server/server.js ] || { echo "[customize] ERROR: the Ember program is missing"; exit 1; }
runuser -u ember -- node --check /opt/ember/current/dist/server/server.js
runuser -u ember -- node -e "require('/opt/ember/current/node_modules/ws'); require('/opt/ember/current/node_modules/serialport')" \
  || { echo "[customize] ERROR: the program's libraries do not load on this CPU (serialport)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "[customize] ERROR: ffmpeg is missing"; exit 1; }
for f in /usr/local/sbin/ember-helper /usr/local/lib/ember/embersys.py; do
  [ "$(stat -c %u "$f")" = 0 ] || { echo "[customize] ERROR: $f does not belong to root"; exit 1; }
done
log "Kernel support for the laser's USB serial chip:"
has_mod() { local d; for d in /lib/modules/*/; do grep -q "/$1\.ko" "$d/modules.builtin" 2>/dev/null && return 0; [ -n "$(find "$d" -name "$1.ko*" -print -quit 2>/dev/null)" ] && return 0; done; return 1; }
for m in ch341 cp210x ftdi_sio cdc_acm usbserial uvcvideo; do if has_mod "$m"; then log "  $m: yes"; else log "  $m: no"; fi; done
has_mod uvcvideo || log "WARNING: this kernel has no uvcvideo, so USB webcams will not work"
has_mod ch341 || has_mod cdc_acm || log "WARNING: no ch341/cdc_acm serial driver: the Falcon2 may not be found"
log "Customize done"
