export const resultValue = (message: string) => ({ ok: true, log: message, outputEntries: [{ result: true, logType: 'MESSAGE', message }] });
export function readResult(code: string, body: string) {
  const marker = code.match(/ACCESS_COMPLETE_/)![0];
  return resultValue(marker + body + marker + body.length);
}
export const writeResult = (code: string) => resultValue(JSON.parse(code.trim().split('\n').at(-1)!));
