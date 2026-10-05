import { stdin, stdout } from "node:process";

/** Read one password without ever accepting it as a command-line argument. */
export async function readPassword(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!password) {
      throw new Error("Password is required on stdin");
    }
    return password;
  }

  return new Promise((resolve, reject) => {
    let password = "";
    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password prompt cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          if (!password) {
            reject(new Error("Password is required on stdin"));
          } else {
            resolve(password);
          }
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          if (password.length > 0) {
            password = password.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        password += character;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    stdout.write("Password: ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
