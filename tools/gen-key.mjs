// Gera par RSA 2048 para fixar o ID da extensão via "key" no manifest.
// Uso: node tools/gen-key.mjs           (não sobrescreve keys/ existente)
//      node tools/gen-key.mjs --print   (só calcula ID/redirect a partir da chave existente)
// Grava keys/spotytube.pem (privada, NÃO versionar) e atualiza manifest.json ("key").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyDir = path.join(root, 'keys');
const pemPath = path.join(keyDir, 'spotytube.pem');
const manifestPath = path.join(root, 'manifest.json');

/** ID da extensão = primeiros 16 bytes do SHA-256 do SPKI DER, hex mapeado 0-f -> a-p. */
export function extensionIdFromSpkiDer(der) {
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

let privateKey;
if (fs.existsSync(pemPath)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(pemPath));
} else {
  if (process.argv.includes('--print')) throw new Error('keys/spotytube.pem não existe');
  fs.mkdirSync(keyDir, { recursive: true });
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('chave privada gerada em', path.relative(root, pemPath));
}
const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const b64 = der.toString('base64');
const id = extensionIdFromSpkiDer(der);

if (!process.argv.includes('--print')) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key = b64;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('manifest.json atualizado com "key"');
}
console.log('ID da extensão :', id);
console.log('Redirect URI   :', `https://${id}.chromiumapp.org/`);
