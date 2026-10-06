import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const AVD = process.env.AVD_NAME ?? 'push-demo';
const BOOT_TIMEOUT_MS = Number(process.env.EMULATOR_BOOT_TIMEOUT_MS ?? 240_000);

function findSdk(): string | undefined {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    '/opt/homebrew/share/android-commandlinetools',
    join(homedir(), 'Library/Android/sdk'),
  ];
  return candidates.find((p) => p && existsSync(join(p, 'emulator', 'emulator')));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adbOut(...args: string[]): string {
  try {
    return execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  } catch {
    return '';
  }
}

const deviceStates = () =>
  adbOut('devices')
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2)
    .map(([serial, state]) => ({ serial, state }));

const booted = () => adbOut('shell', 'getprop', 'sys.boot_completed').trim() === '1';

/** Makes sure an Android emulator is running and booted; starts the AVD when none is. */
export async function ensureEmulator(log: (msg: string) => void = console.log): Promise<void> {
  const sdk = findSdk();
  if (sdk) {
    process.env.ANDROID_HOME ??= sdk;
    process.env.ANDROID_SDK_ROOT ??= sdk;
    process.env.PATH = `${join(sdk, 'platform-tools')}:${process.env.PATH}`;
  }

  if (deviceStates().some((d) => d.state === 'device') && booted()) return;

  if (!deviceStates().length || deviceStates().some((d) => d.state === 'offline')) {
    adbOut('kill-server'); // clears stale/offline entries left by a dead emulator
    adbOut('start-server');
  }

  if (!deviceStates().some((d) => d.state === 'device' || d.state === 'offline')) {
    if (!sdk) throw new Error('Android SDK not found. Set ANDROID_HOME (needs the emulator package).');
    log(`Starting Android emulator "${AVD}"…`);
    const out = openSync(join(tmpdir(), 'emulator.log'), 'a');
    const child = spawn(join(sdk, 'emulator', 'emulator'), ['-avd', AVD, '-no-snapshot', '-no-audio'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ANDROID_SDK_ROOT: sdk },
    });
    child.unref(); // keep running after the test process exits
  } else {
    log('Waiting for Android emulator to come online…');
  }

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (deviceStates().some((d) => d.state === 'device') && booted()) {
      adbOut('shell', 'input', 'keyevent', 'KEYCODE_HOME');
      // Wait for the launcher to actually be in focus instead of sleeping a fixed time.
      const settle = Date.now() + 30_000;
      while (Date.now() < settle && !/mCurrentFocus=.*Launcher/i.test(adbOut('shell', 'dumpsys', 'window'))) {
        await sleep(500);
      }
      log('Android emulator is ready');
      return;
    }
    await sleep(3000);
  }
  throw new Error(`Android emulator "${AVD}" did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s`);
}
