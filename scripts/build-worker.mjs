import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'app.js', 'styles.css', 'privacy.html', 'manifest.webmanifest']) {
  await copyFile(path.join(root, name), path.join(output, name));
}
async function copyPublic(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Public assets cannot be symlinks');
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) { await mkdir(path.join(output, relative), { recursive: true }); await copyPublic(relative); }
    else if (/\.(js|svg)$/.test(entry.name) || /-LICENSE$/.test(entry.name)) await copyFile(path.join(root, relative), path.join(output, relative));
  }
}
for (const directory of ['src', 'assets']) { await mkdir(path.join(output, directory)); await copyPublic(directory); }
const configPath = path.join(output, 'src/google-health-config.js');
const config = await readFile(configPath, 'utf8');
if (!config.includes('export const GOOGLE_HEALTH_PERSISTENT = false;')) throw new Error('Unexpected authentication config');
await writeFile(configPath, config.replace('export const GOOGLE_HEALTH_PERSISTENT = false;', 'export const GOOGLE_HEALTH_PERSISTENT = true;'));
const privacyPath = path.join(output, 'privacy.html');
let privacy = await readFile(privacyPath, 'utf8');
privacy = privacy.replace(/      <h2>Versione con accesso mantenuto su Cloudflare<\/h2>[\s\S]*?(?=      <h2>Collegamento facoltativo)/, '');
const paragraphs = {
  'health-transport': 'Le letture delle calorie e gli invii confermati dei pasti partono dal browser verso Google. Il servizio Pasti su Cloudflare gestisce invece l’accesso Google, verifica l’identità Health e conserva le credenziali cifrate per rinnovarlo. Il diario, il profilo nutrizionale e le calorie lette non sono memorizzati nel database del servizio.',
  'health-persistence': 'Un cookie tecnico Secure e HttpOnly identifica la sessione di questo dispositivo per 90 giorni dall’ultimo utilizzo del collegamento. Il database D1 su Cloudflare conserva l’identificativo della sessione sotto forma di hash e, cifrati con AES-GCM, i token e l’identificativo Health. Il browser riceve soltanto un token a breve durata, mantenuto in memoria e mai inserito nel backup. Riaprire il sito ripristina l’accesso finché la sessione e l’autorizzazione Google sono valide. Il sito legge le calorie soltanto mentre la pagina è aperta e visibile.',
  'health-disconnect': 'Scollega questo dispositivo elimina la sua sessione dal database del servizio e il cookie dal browser. Le credenziali non vengono più usate per rinnovare l’accesso; eventuali copie nei backup del fornitore seguono la sua conservazione. Le sessioni scadute vengono eliminate al successivo avvio di un’autorizzazione. Per revocare anche i permessi Google, apri le <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">connessioni del tuo account Google</a> e rimuovi Pasti. Le ricevute locali e i pasti già inviati restano presenti.',
  'health-providers': 'Cloudflare distribuisce questa versione del sito, esegue il servizio di accesso e conserva le sessioni cifrate in D1. Google gestisce il consenso e i dati Health. Questi servizi ricevono le normali informazioni delle richieste di rete, come l’indirizzo IP. Informative: <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">Cloudflare</a> e <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google</a>.',
};
for (const [id, text] of Object.entries(paragraphs)) {
  const pattern = new RegExp(`<p id="${id}">[\\s\\S]*?</p>`);
  if (!pattern.test(privacy)) throw new Error(`Missing privacy paragraph ${id}`);
  privacy = privacy.replace(pattern, `<p id="${id}">${text}</p>`);
}
await writeFile(privacyPath, privacy);
await writeFile(path.join(output, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n`);
console.log('Built public-only dist/ with same-origin persistent authentication.');
