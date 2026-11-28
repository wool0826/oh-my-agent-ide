// Stands in for Electron when tests bundle main-process modules (see the test script's --alias).
// The code under test imports these names but must not need a running Electron app.

export const app = {
  isPackaged: false,
  getPath(): string { throw new Error('Electron is not available in tests; set OMA_DATA_DIR.'); },
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

export class BrowserWindow {}

export class Notification {
  static isSupported() { return false; }
  show() {}
}

export const nativeImage = {
  createFromDataURL: () => ({ isEmpty: () => true }),
};
