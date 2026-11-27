// Local-only typecheck driver. Uses the typescript package when it happens to be
// installed in node_modules; otherwise exits 0 with a notice.
import { existsSync } from 'node:fs';

const tsPath = new URL('./node_modules/typescript/lib/typescript.js', import.meta.url);
if (!existsSync(tsPath)) {
  console.log('typescript not installed; skipping typecheck');
  process.exit(0);
}

const ts = await import(tsPath.href);
const configPath = new URL('./tsconfig.check.json', import.meta.url).pathname;
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  new URL('.', import.meta.url).pathname,
);

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);

for (const diagnostic of diagnostics) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    console.error(
      `${diagnostic.file.fileName}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`,
    );
  } else {
    console.error(`TS${diagnostic.code}: ${message}`);
  }
}

console.log(`typecheck: ${diagnostics.length} diagnostic(s)`);
process.exit(diagnostics.length === 0 ? 0 : 1);
