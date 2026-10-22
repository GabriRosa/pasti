# Attività svolta e dati da Strava

Pasti registra per ogni giorno palestra, corsa, entrambe oppure riposo. La registrazione effettiva è separata dal calendario previsto. Se non hai registrato un’attività, il giorno resta **Non ancora registrato**: l’assenza di dati non indica riposo.

La registrazione non cambia il deficit, le calorie o i pasti. Il consumo giornaliero stimato dal profilo comprende già gli allenamenti abituali; sommare nuovamente le calorie di una corsa conterebbe due volte una parte del dispendio.

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
