# Attività, calorie e collegamenti

Pasti registra per ogni giorno palestra, corsa, entrambe oppure riposo. La registrazione effettiva è separata dal calendario previsto. Se non hai registrato un’attività, il giorno resta **Non ancora registrato**: l’assenza di dati non indica riposo.

La registrazione non cambia il deficit, le calorie o i pasti. Il consumo giornaliero stimato dal profilo comprende già gli allenamenti abituali; sommare nuovamente le calorie di una corsa conterebbe due volte una parte del dispendio.

## Calorie da Google Health

La scheda Google Health legge il consumo energetico della data aperta tramite la Google Health API v4. Il connettore usa due aggregazioni riconciliate: `total-calories`, che comprende metabolismo a riposo e attività, e `active-energy-burned`, che rappresenta la sola quota attiva. I due valori non si sommano. Pasti mantiene separati il consumo letto da Google, le calorie assunte con i pasti e l’obiettivo stimato dal profilo.

Per oggi, l’intervallo parte dalla mezzanotte in `Europe/Rome` e termina all’ultimo minuto completato. Per un giorno passato copre l’intera giornata, comprese le giornate di 23 o 25 ore al cambio dell’ora. I giorni futuri non generano richieste. La dicitura relativa all’ultima lettura indica quando Pasti ha consultato Google, non quando l’orologio ha sincronizzato i dati.

I risultati sono stime del servizio. Una metrica assente rimane non disponibile; uno zero presente è uno zero valido. Se Google restituisce soltanto una parte degli intervalli richiesti, la scheda segnala la copertura parziale. Nessuna lacuna viene riempita con il metabolismo calcolato da Pasti. Il risultato dipende dai dati effettivamente presenti su Google Health: il collegamento non garantisce che tutte le attività di Garmin, Hevy o Strava siano confluite nell’account.

### Accesso durante la sessione

Pasti usa il token model di Google Identity Services, con il solo permesso `googlehealth.activity_and_fitness.readonly`. La finestra Google si apre da un’azione dell’utente. Dopo il consenso, Pasti verifica che esista un profilo Google Health prima di leggere le calorie. Un account non collegato richiede prima l’accesso all’app mobile Google Health con lo stesso account.

Il token e le letture restano nella memoria della pagina: non vengono salvati nel `localStorage`, nei backup o nei file pubblici. Il diario alimentare non viene inviato a Google. La sessione termina alla ricarica, alla chiusura, alla scadenza del token o alla disconnessione locale. Per riprendere serve un nuovo clic su Collega o Ricollega. L’aggiornamento periodico avviene ogni cinque minuti soltanto per oggi, con pagina visibile e accesso valido; dopo un errore si sospende e lascia disponibile il comando manuale.

Disconnetti cancella dalla sessione token e risultati; per revocare il permesso Google bisogna rimuovere Pasti dalle [connessioni dell’account Google](https://myaccount.google.com/connections). Vedi anche [come vengono usati i dati](../privacy.html).

### Configurazione dell’installazione

L’identificativo pubblico del client OAuth viene letto da [google-health-config.js](../src/google-health-config.js). Se è vuoto, la scheda indica che la configurazione deve essere completata e non avvia l’accesso. Non inserire mai un client secret o un token in questo file.

La configurazione Google richiede un progetto con Google Health API abilitata, un’app OAuth e un client Web con origine JavaScript autorizzata `https://gabrirosa.github.io`, senza il percorso `/pasti/`. Per le prove locali occorre autorizzare separatamente l’origine e la porta usate. Gli utenti di prova devono essere aggiunti alla configurazione Google. L’abilitazione comporta l’accettazione dei termini Google; il consenso alla lettura dei dati resta un passaggio distinto dell’utente.

Il codice del collegamento è disponibile; **il client non è ancora configurato e nessun account Google Health è stato collegato o verificato con dati reali**. I test usano risposte sintetiche. Non è stato attivato un servizio che aggiorni i dati a pagina chiusa.

Fonti ufficiali: [calorie Google Health](https://developers.google.com/health/data-types/calories), [aggregazioni rollUp](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/rollUp), [identità del profilo](https://developers.google.com/health/reference/rest/v4/users/getIdentity), [accesso dal browser](https://developers.google.com/identity/oauth2/web/guides/use-token-model) e [configurazione Google](https://developers.google.com/health/setup). Verificate il 23 ottobre 2026.

## Importazione gratuita da un file

Puoi importare un CSV del tuo archivio Strava senza collegare un account API. Dal sito Strava apri **Settings → My Account → Download your account → Get Started → Request download**. Strava invia il collegamento all’archivio via email; l’attesa può durare alcune ore. Estrai il file delle attività CSV prima di aprirlo in Pasti. Il sito non legge l’intero ZIP. [Procedura ufficiale Strava, aggiornata il 14 settembre 2026](https://support.strava.com/en-us/articles/15401919-how-do-i-export-my-strava-data).

1. Apri la data desiderata nel diario Pasti e scegli **Importa attività da CSV**.
2. Seleziona il file delle attività, poi controlla le colonne di data, tipo e identificativo.
3. Indica se gli orari privi di fuso nel file sono UTC oppure locali italiani. Le date con un fuso esplicito vengono convertite in `Europe/Rome`.
4. Controlla il risultato per il giorno scelto. Una corsa e una seduta di pesi producono **Palestra + corsa**. Tipi generici come `Workout` richiedono conferma del tipo effettivo.
5. Conferma la registrazione. Se il giorno ne aveva già una, la nuova scelta la sostituisce; gli altri giorni e i pasti restano invariati.

Il file viene letto nel browser. Pasti conserva soltanto il tipo di attività confermato, la provenienza dell’importazione e l’ora della registrazione. Non salva il CSV, i titoli, i percorsi GPS, la frequenza cardiaca o le calorie dell’allenamento e non carica questi dati su GitHub.

La guida pubblica Strava non garantisce uno schema CSV o un fuso universale. Per questo le colonne sono modificabili, il riferimento degli orari richiede una scelta e l’anteprima precede sempre il salvataggio. La compatibilità con un export personale va verificata sul suo contenuto; i test inclusi usano dati sintetici. Un file non riconosciuto non cambia il diario. Non vengono importati GPX, FIT, TCX o ZIP.

## Collegamenti automatici: stato attuale

**Nessun account Strava, Garmin o Hevy è attualmente collegato a Pasti.** L’importazione CSV è manuale e non riceve attività successive all’esportazione.

| Servizio | Possibilità verificata il 23 ottobre 2026 | Requisito per Pasti |
| --- | --- | --- |
| Strava | La guida attuale richiede un abbonamento per creare una nuova app API personale. | App registrata, autorizzazione OAuth e servizio privato per custodire e rinnovare i token. |
| Hevy | Gli allenamenti possono essere inviati a Strava, con sincronizzazione unidirezionale. | Se sono già presenti su Strava, il relativo archivio può includerli; la classificazione deve essere controllata. |
| Garmin | È disponibile una Personal API per accedere ai propri dati. | Chiave generata dall’utente e integrazione dedicata; disponibilità e termini dell’account devono essere verificati. |

Fonti: [Strava Getting Started](https://developers.strava.com/docs/getting-started/), [OAuth Strava](https://developers.strava.com/docs/authentication/), [Hevy–Strava](https://help.hevyapp.com/hc/en-us/articles/38279744541591-Using-Hevy-with-Strava-Setup-Syncing-and-Editing-Workouts), [Garmin Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/) e [FAQ Garmin](https://developer.garmin.com/gc-developer-program/personal/personal-faq/).

La parte pubblica di Pasti resta su GitHub Pages. Un eventuale collegamento Strava deve conservare il client secret e i token in un servizio privato, separato dai file pubblici e dai backup del diario. Non è stato creato né attivato questo servizio. L’accesso personale Garmin riguarda i dati presenti su Garmin e non recupera da solo gli allenamenti Hevy inviati soltanto a Strava.
