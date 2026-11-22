import { MachineController, type ConnectRequest } from './controller'
import { listSerialPorts } from '../core/connection/network'

async function discoverEsp32(): Promise<{ name: string; host: string; port: number }[]> {
  const { Bonjour } = await import('bonjour-service')
  const b = new Bonjour()
  const found = new Map<string, { name: string; host: string; port: number }>()
  await new Promise<void>((resolve) => {
    const br = b.find({ type: 'ember-laser' }, (svc) => {
      const host = svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? svc.host
      found.set(svc.name, { name: svc.name, host, port: svc.port })
    })
    setTimeout(() => {
      br.stop()
      resolve()
    }, 2500)
  })
  b.destroy()
  return [...found.values()]
}

export function coreHandlers(controller: MachineController): Record<string, (a: any) => unknown> {
  return {
  'ports.list': () => listSerialPorts(),
  'esp32.discover': () => discoverEsp32(),
  connect: (a: ConnectRequest) => controller.connect(a),
  disconnect: () => controller.disconnect(),
  send: (a: { text: string }) => controller.send(a.text),
  jog: (a: { x?: number; y?: number; z?: number; feed: number }) => controller.jog(a, a.feed),
  jogCancel: () => controller.jogCancel(),
  home: () => controller.home(),
  unlock: () => controller.unlock(),
  zero: () => controller.zero(),
  goto: (a: { x: number; y: number }) => controller.goto(a.x, a.y),
  reset: () => controller.reset(),
  override: (a: { kind: 'feed' | 'spindle' | 'rapid'; pct: number }) => controller.override(a.kind, a.pct),
  pulse: (a: { pct: number; maxS: number }) => controller.pulse(a.pct, a.maxS),
  'settings.request': () => controller.requestSettings(),
  'settings.write': (a: { id: number; value: string }) => controller.writeSetting(a.id, a.value),
  'job.start': (a: { lines: string[]; name: string; where: 'pc' | 'device' }) => controller.startJob(a.lines, a.name, a.where),
  'job.pause': () => controller.pause(),
  'job.resume': () => controller.resume(),
  'job.stop': () => controller.stop(),
  estop: () => controller.emergencyStop(),
  'device.files': () => controller.deviceFiles(),
  'device.remove': (a: { name: string }) => controller.deviceRemove(a.name),
  'device.run': (a: { name: string }) => controller.deviceRun(a.name),
  'device.attach': () => controller.attachDeviceJob(),
  }
}
