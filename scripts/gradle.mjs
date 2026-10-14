// Runs the Gradle wrapper inside android/ (works on Windows paths that contain "&", and on Linux / macOS).
//   node scripts/gradle.mjs assembleDebug
//   node scripts/gradle.mjs assembleRelease -PappVersionName=1.2.3 -PappVersionCode=10203
// Needs JDK 21 and the Android SDK (ANDROID_HOME, or android/local.properties with sdk.dir).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'android');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/gradle.mjs <gradle tasks and options>');
  process.exit(2);
}

const wrapper = win ? 'gradlew.bat' : './gradlew';
// On Windows the .bat has to go through cmd, so quote everything that may hold spaces or "&".
const result = win
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${wrapper} ${args.map((a) => `"${a}"`).join(' ')}"`], { cwd: androidDir, stdio: 'inherit', windowsVerbatimArguments: true })
  : spawnSync(wrapper, args, { cwd: androidDir, stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
