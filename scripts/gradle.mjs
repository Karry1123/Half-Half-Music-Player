// Runs the Gradle wrapper inside android/ (works on Windows paths that contain "&", and on Linux / macOS).
//   node scripts/gradle.mjs assembleDebug
//   node scripts/gradle.mjs assembleRelease -PappVersionName=1.2.3 -PappVersionCode=10203
// Needs JDK 21 and the Android SDK (ANDROID_HOME, or android/local.properties with sdk.dir).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const androidDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'android');
const win = process.platform === 'win32';
const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/gradle.mjs <gradle tasks and options>');
  process.exit(2);
}

const wrapper = './gradlew';
// Invoke the same wrapper JAR directly on Windows. gradlew.bat expands unquoted
// directory variables internally, breaking workspace names containing "&".
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java.exe';
const env = { ...process.env };
if (win) {
  // Long Windows sandbox TEMP paths exceed the JDK Unix-domain socket limit.
  const temp = path.join(androidDir, '..', '.build-tmp');
  mkdirSync(temp, { recursive: true });
  env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS || ''} "-Djdk.net.unixdomain.tmpdir=${temp}"`.trim();
}
const result = win
  ? spawnSync(java, ['-classpath', path.join(androidDir, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', ...args], { cwd: androidDir, stdio: 'inherit', env })
  : spawnSync(wrapper, args, { cwd: androidDir, stdio: 'inherit' });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
