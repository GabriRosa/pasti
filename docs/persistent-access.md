# Accesso Google mantenuto tra le aperture

La versione Cloudflare di Pasti usa un servizio OAuth sullo stesso dominio del sito. Il browser conserva un cookie di sessione Secure, HttpOnly e SameSite=Lax. Il Worker conserva in D1 i token Google e l’identificativo Health cifrati con AES-GCM; l’identificativo del cookie è salvato sotto forma di hash. Le calorie e il diario non entrano in questo database.

La versione è pubblicata su [Pasti con accesso mantenuto](https://pasti.gabri-rosso02.workers.dev/) dal 27 ottobre 2026, con Cloudflare Workers Free e D1 Free. Database, segreti e redirect Google sono configurati. L’app Google è in produzione, ma non ancora verificata da Google: il consenso mostra il relativo avviso. Il 27 ottobre 2026 sono stati verificati in Chrome il consenso reale, la lettura Google Health e il ripristino automatico dopo ricarica e chiusura/riapertura della scheda, senza nuovo consenso. Il rinnovo dopo la scadenza del token breve è coperto dai test automatici, ma non è ancora stato osservato dal vivo. Sono verificati anche HTTPS, avvio OAuth e rifiuto delle richieste senza sessione o da origini diverse. Il repository su GitHub Pages mantiene `GOOGLE_HEALTH_PERSISTENT = false` e continua a usare l’accesso limitato alla pagina aperta. Il build Cloudflare abilita il collegamento persistente nella sola cartella generata `dist/`.

## Sessione e rinnovo

[google-health-persistent.js](../src/google-health-persistent.js) comunica soltanto con `/api/health/` sul proprio dominio. [google-health-session.js](../src/google-health-session.js) ripristina l’accesso all’apertura e chiede il rinnovo prima della scadenza mentre la pagina è visibile. Il token breve resta nella memoria JavaScript. Il refresh token resta sul server.

La sessione dura 90 giorni dall’ultimo utilizzo dell’endpoint di ripristino. Chiudere o ricaricare la pagina svuota la memoria, senza scollegare il dispositivo. Il comando **Scollega questo dispositivo** cancella invece la sessione dal server e il cookie. Le righe già scadute vengono eliminate al successivo avvio di un’autorizzazione. I backup D1 seguono la conservazione del fornitore.

L’autorizzazione non è garantita per sempre: Google può revocarla o farla scadere. Un’app OAuth esterna in modalità **Test** riceve normalmente refresh token validi sette giorni per questi permessi. Il passaggio a produzione è stato completato; la verifica Google resta distinta e non è stata completata. La produzione elimina la scadenza standard di sette giorni propria della modalità Test, senza garantire una durata illimitata.

Il permesso per inviare i pasti rimane separato. Il rinnovo e la riapertura del sito non inviano pasti; resta necessaria la selezione e la conferma nell’anteprima esistente. Un ampliamento del permesso deve riguardare la stessa identità Health della sessione corrente.

## File e configurazione

| File | Ruolo |
| --- | --- |
| [server/worker.js](../server/worker.js) | Codice OAuth, cookie, cifratura, rinnovo e disconnessione |
| [0001_health_sessions.sql](../server/migrations/0001_health_sessions.sql) | Tabelle di sessioni e autorizzazioni temporanee |
| [wrangler.example.jsonc](../wrangler.example.jsonc) | Configurazione da copiare in `wrangler.local.jsonc`, escluso da Git |
| [build-worker.mjs](../scripts/build-worker.mjs) | Copia dei soli file pubblici, configurazione e informativa della versione Cloudflare |

Le variabili pubbliche del Worker sono `APP_ORIGIN` (origine HTTPS esatta, senza slash finale) e `GOOGLE_CLIENT_ID`. Il binding D1 si chiama `DB`. I segreti sono `GOOGLE_CLIENT_SECRET` e `TOKEN_ENCRYPTION_KEY` (32 byte casuali codificati Base64). Non vanno messi nei file pubblici, nei comandi salvati in cronologia, nei backup del diario o nel repository. Il client ID nel sito e nel Worker deve coincidere, anche per riconoscere le ricevute degli invii.

La configurazione disabilita osservabilità e URL di anteprima. I log delle richieste OAuth possono contenere codici temporanei: non attivare log di URL, body, cookie o header Authorization. Il Worker restituisce gli endpoint OAuth con `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## Attivazione sul piano gratuito

1. Verificare in Cloudflare l’account personale e il piano **Workers Free**. Usare il sottodominio `workers.dev`, senza acquistare un dominio o attivare piani, componenti o upgrade a pagamento. Il nome `pasti` nel modello è modificabile se già occupato nell’account.
2. Con Node e il CLI ufficiale Wrangler disponibili, autenticare Wrangler sul medesimo account. Verificare l’identità con `wrangler whoami` prima di scrivere risorse. Creare il database con `wrangler d1 create pasti-auth` e riportare l’identificativo reale nel file locale di configurazione. Nessun identificativo di esempio è distribuibile.
3. Impostare `APP_ORIGIN` con l’URL reale del Worker. Aggiungere al client Web Google il redirect esatto `APP_ORIGIN/api/health/callback`. Conservare le origini già usate da GitHub Pages. Verificare stato di pubblicazione, pubblico e requisiti Google; completare l’eventuale approvazione dei nuovi permessi.
4. Inserire i segreti tramite `wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.local.jsonc` e `wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.local.jsonc`, usando l’input protetto/interattivo. Il secondo segreto deve essere generato con un generatore crittografico. Cambiarlo invalida le sessioni cifrate esistenti.
5. Eseguire `node --test tests/*.test.mjs`, poi `node scripts/build-worker.mjs`. Applicare lo schema con `wrangler d1 migrations apply pasti-auth --remote --config wrangler.local.jsonc` e distribuire con `wrangler deploy --config wrangler.local.jsonc`. Ricontrollare account e piano gratuito prima di questi comandi.
6. Dal telefono verificare consenso, lettura, ricarica, chiusura e riapertura, rinnovo dopo la scadenza del token breve e disconnessione esplicita. I test locali usano risposte Google sintetiche e SQLite; non sostituiscono questa verifica reale.

Il piano Free include limiti di richieste, CPU e database. Quando D1 esaurisce le quote gratuite restituisce errori; non serve attivare un upgrade per conservare il diario locale. L’account deve rimanere sul piano gratuito: il file Wrangler non modifica né garantisce il piano di fatturazione dell’account.

## Diario sul nuovo indirizzo

Il nuovo dominio ha una memoria locale distinta. Prima del passaggio, esportare il backup dal vecchio Pasti sul telefono; nel nuovo indirizzo importarlo dall’interfaccia e controllare il risultato prima di confermare. Il sito vecchio rimane disponibile. Le ricevute tecniche degli invii Google non sono incluse nel backup: sul nuovo dominio la verifica delle voci remote resta necessaria prima di inviare pasti già registrati su Google.

## Endpoint e controlli

Tutti i POST richiedono l’header `X-Pasti-Request: 1` e `Origin` uguale a `APP_ORIGIN`. Il servizio non abilita CORS. L’avvio richiede anche JSON. Gli errori di callback espongono soltanto codici fissi per distinguere configurazione, rete, identità e salvataggio; non espongono messaggi grezzi del fornitore o credenziali. Il callback è un GET con stato monouso, legato a un cookie di dieci minuti e a PKCE S256. Il rinnovo usa un lock D1; una disconnessione durante una richiesta impedisce di ricreare la sessione cancellata.

| Metodo e percorso | Risultato |
| --- | --- |
| `POST /api/health/start` | `{nutrition: false}` avvia lettura; `true` amplia una sessione esistente; restituisce l’URL Google |
| `GET /api/health/callback` | Verifica il codice Google, crea una nuova sessione e torna al diario |
| `POST /api/health/session` | Restituisce token breve, durata, permessi e identità oppure 401 senza sessione valida |
| `POST /api/health/disconnect` | Elimina sessione e autorizzazioni pendenti di questo browser |

Fonti ufficiali consultate il 27 ottobre 2026: [Google OAuth per server Web](https://developers.google.com/identity/protocols/oauth2/web-server), [scadenza delle autorizzazioni Google](https://developers.google.com/identity/protocols/oauth2#expiration), [Workers con file statici](https://developers.cloudflare.com/workers/static-assets/), [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/), [D1 Free e superamento quote](https://developers.cloudflare.com/d1/platform/pricing/), [segreti Worker](https://developers.cloudflare.com/workers/configuration/secrets/).
