# Pasti

Pasti è un diario alimentare in italiano che genera proposte giornaliere dai dati del profilo e permette di modificare alimenti e quantità. È un’app statica, senza framework o passaggio di build, pensata per GitHub Pages e per l’uso dal telefono. Il collegamento facoltativo a Google Health usa Google Identity Services.

## Uso

Al primo accesso inserisci età, peso, altezza, sesso usato nella formula, attività abituale e obiettivo. Il profilo mostra la stima del consumo a riposo, il consumo giornaliero medio e l’obiettivo calorico. Per perdere peso scegli il deficit in kcal: l’obiettivo è il consumo medio meno il valore inserito. Il valore zero mantiene le calorie stimate di mantenimento.

In Profilo, **Calorie e macro scelti da me** consente di inserire kcal, proteine e grassi; i carboidrati derivano dall’energia residua. Il **Piano 2.200 kcal · shaker, latte scremato e cioccolato** seleziona 2.200 kcal, 144 g di proteine e 80 g di grassi e usa le porzioni descritte nel [metodo](docs/nutrition.md#piano-con-latte-scremato-e-cioccolato). Il diario distingue questi riferimenti dai totali degli ingredienti. Le note su attività e preferenze restano nel profilo locale e sono consultabili nel diario.

L’orario iniziale degli allenamenti è 06:00. Puoi alternare corsa e sala attrezzi ogni giorno, scegliendo una data di riferimento e la prima attività, oppure assegnare corsa, sala attrezzi o riposo ai giorni della settimana. L’alternanza prosegue anche tra settimane e mesi. Il piano distingue uno spuntino facoltativo prima dell’allenamento dalla colazione successiva; seguono pranzo e cena.

Nella scheda **Attività svolta** scegli **Palestra**, **Corsa**, **Palestra + corsa** oppure **Riposo** per la data aperta. Il programma previsto resta separato dalla registrazione effettiva. Puoi correggere o annullare la scelta per oggi e per i giorni passati; i giorni futuri restano da registrare. La scelta viene conservata nel diario senza modificare pasti, deficit o calorie: il consumo medio include già gli allenamenti abituali.

**Importa attività da CSV** legge localmente il file delle attività esportato da Strava e propone una registrazione per il solo giorno aperto. Conferma le colonne e come interpretare gli orari, controlla l’anteprima e applica il risultato. I tipi generici e le righe non interpretabili richiedono una scelta esplicita. Non è una sincronizzazione automatica. Vedi [collegamenti e importazione](docs/integrations.md) per requisiti e limiti.

La scheda **Google Health** può leggere le calorie bruciate nella data aperta, distinguendo il totale dalla quota attiva già inclusa. Richiede la configurazione del client Google e il consenso dell’utente. Nella versione GitHub Pages il collegamento dura per la sessione: la pagina può aggiornarsi ogni cinque minuti mentre è visibile; dopo una ricarica o la scadenza dell’accesso serve ricollegarsi. La scheda indica l’ora della lettura e segnala dati assenti o parziali. Il consumo letto da Google non modifica automaticamente gli obiettivi o i pasti. Lo stato di configurazione e i passaggi necessari sono descritti nella [guida ai collegamenti](docs/integrations.md).

Con il permesso facoltativo per l’invio dei pasti puoi caricare su Google Health le registrazioni che selezioni nell’anteprima del giorno. Pasti invia titolo, data, calorie, proteine, carboidrati e grassi dalla copia salvata quando hai segnato il pasto come mangiato. Aprire un giorno, collegare Google o importare un backup non avvia caricamenti. Un pasto già inviato non viene inviato nuovamente; un esito incerto richiede una verifica, senza ripetere automaticamente la scrittura.

Il diario mostra obiettivo stimato, quantità pianificate e quantità consumate. Apri **Modifica porzioni e alternative** per cambiare un pasto o i grammi, poi **Segna mangiato** per registrarlo. La registrazione si può annullare. I giorni futuri si possono pianificare; la registrazione diventa disponibile dalla data scelta.

Le alternative comprendono i carboidrati richiesti (pasta, riso, couscous, patate e pasta di lenticchie), pollo, uova, albumi, salmone, tonno e filetto di maiale. Le colazioni includono budino e mousse proteici, yogurt greco con cioccolato fuso e altre proposte.

Le schede Lidl identificano le confezioni verificate: sedanini secchi Combino, fusilli freschi Nonna Mia, budini Milbona cacao e vaniglia da 200 g, mousse Milbona cioccolato e vaniglia da 175 g. In **Alimenti** trovi i valori per 100 g, la data di verifica e il collegamento alla fotografia dell’etichetta. Ogni voce si riferisce alla variante indicata; la modifica manuale è facoltativa per confezioni diverse. La pasta fresca si pesa prima della cottura, senza convertirla in peso secco.

Quando cambi il carboidrato di pranzo o cena, il piano adatta anche carne, pesce o uova e mostra le porzioni prima e dopo la scelta. Le proteine della pasta di lenticchie e degli altri ingredienti contribuiscono già al totale.

## Codici a barre e porzioni personali

In **Alimenti → Inquadra codice a barre** puoi leggere un EAN/UPC con la fotocamera. Sono accettati codici di 8, 12, 13 o 14 cifre con controllo della cifra finale. Puoi anche scrivere il codice o inserire il prodotto a mano. La fotocamera richiede HTTPS (oppure localhost) e il permesso del browser.

La ricerca consulta [Open Food Facts](https://world.openfoodfacts.org), con attribuzione [ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Controlla i valori con la confezione: i campi mancanti restano vuoti e devono essere completati. Scegli la base per 100 g o 100 ml e la quantità della porzione per vedere subito calorie e macro. Non viene applicata una conversione tra peso e volume.

**Salva porzione personale** conserva fino a 200 porzioni locali. Da ciascuna scheda puoi modificare la porzione, eliminarla oppure aggiungerla a un pasto del giorno selezionato nel diario. L’anteprima mostra i nuovi totali; l’aggiunta propone di adattare gli ingredienti ai macro del pasto. Puoi disattivare questa scelta per mantenere la porzione esatta. Il pasto resta da mangiare. Dal diario puoi modificare la quantità o rimuovere l’ingrediente personale. Le copie già aggiunte ai pasti non cambiano quando aggiorni o elimini la porzione originale.

[barcode.js](src/barcode.js) legge l’API Open Food Facts v3.6, usa soltanto nutrienti normalizzati per 100 g/ml del prodotto come venduto e annulla le richieste dopo 15 secondi. Un errore di rete o un prodotto assente consente comunque l’inserimento manuale. Il lettore [ZXing Browser 0.2.1](src/vendor/README.md) viene caricato dai file locali del sito solo quando richiesto. Il flusso video viene chiuso anche in caso di navigazione, pagina nascosta o autorizzazione tardiva dopo la chiusura. Nessuna immagine viene trasmessa.

[portions-ui.js](src/portions-ui.js) gestisce ricerca, anteprima ed elenco. L’archivio mantiene lo schema 1: `personalPortions` è facoltativo nei vecchi backup; gli ingredienti personali includono un `foodSnapshot` validato. [barcode.test.mjs](tests/barcode.test.mjs) verifica codici, nutrienti mancanti, unità, annullamento e ciclo della fotocamera con flussi simulati. I test di integrazione coprono salvataggio, aggiunta, modifica nel pasto, consumo, eliminazione e backup.

## Ricette base e distribuzione dei macro

In **Alimenti → Ricette** trovi le 195 ricette di [Cibo Sano](https://gabrirosa.github.io/cibo-sano/) e cinque basi del piano Pasti. Puoi cercarle per nome o ingrediente, crearne di nuove e modificare ingredienti e dosi, anche tramite codice a barre. Il salvataggio aggiorna la base personale; i pasti già inseriti nel diario mantengono la propria copia. **Alimenti → Porzioni → Quantità abituali degli alimenti** permette di cambiare la porzione proposta per un alimento, lasciando libera la quantità usata ogni volta.

**Alimenti → Impostazioni → Distribuzione dei macro** assegna percentuali distinte di proteine, carboidrati e grassi ai quattro pasti. Ogni colonna deve totalizzare il 100%. Il salvataggio imposta il giorno selezionato e il riferimento dei nuovi giorni. **Adatta i pasti da mangiare** mostra un’anteprima e applica le quantità dopo la conferma. Puoi aprire gli stessi controlli anche da Oggi.

**Usa nel giorno** calcola le dosi della ricetta per il pasto scelto. Il calcolo sottrae i macro già consumati dall’obiettivo giornaliero e ripartisce il residuo tra i pasti ancora da mangiare secondo le percentuali. Le quote di pasti saltati o assenti vengono redistribuite; se tutte le quote residue di un macro sono zero, il residuo è diviso equamente. L’anteprima mostra obiettivo, risultato e scostamento.

[recipe-fitting.js](src/recipe-fitting.js) adatta le dosi tra il 25% e il 400% della base, con limite di 3.000 g/ml per ingrediente. In modalità ingredienti singoli mantiene fissi aromi e piccole quantità fino a 10 g/ml, eccetto alimenti con almeno il 70% di grassi, e gli ingredienti privi di macro. Per impasti e dolci viene proposta la modalità proporzionale, che scala l’intera ricetta con lo stesso fattore. Le dosi si possono modificare successivamente. Gli ingredienti disponibili e i limiti sulle quantità possono impedire di raggiungere esattamente tutti i macro; le calorie riportate derivano dalle etichette.

[base-recipes.js](src/base-recipes.js) conserva il catalogo Cibo Sano del 14 ottobre 2026, gli ingredienti per porzione e i riferimenti delle fonti. I dati CoFID sono Crown copyright, distribuiti con [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Le voci equivalenti del catalogo Pasti usano i valori e le etichette personali correnti. Gli altri alimenti conservano una copia dei valori originali. Tre voci di zucchero CoFID espresse come equivalenti monosaccaridici sono convertite da 105 a 100 g di carboidrati; la provenienza registra la conversione.

I campi facoltativi `personalRecipes` e `mealDistribution` restano nello schema 1 e sono inclusi nei backup. Ogni giorno può conservare la propria distribuzione. I vecchi backup rimangono importabili senza aggiungere ricette o percentuali ai dati storici.

## Gestione dei pasti

Il diario apre **Modifica pasto** con gli ingredienti e le quantità del pasto selezionato. **Aggiungi alimento** apre una modalità alla volta: ricerca, codice a barre oppure inserimento manuale. I risultati compaiono dopo la ricerca; la scelta di un alimento apre il campo quantità. Dopo l’aggiunta si torna agli ingredienti. Le aggiunte restano una bozza fino a **Salva questo pasto**.

**Cambia ricetta** apre una ricerca per nome o ingrediente, inizialmente filtrata sul pasto corrente. Le ricette personali prevalgono sulle alternative omonime del piano. La scelta torna agli ingredienti con le dosi adattate ai macro; **Adatta quantità ai macro** permette di ricalcolare la composizione corrente. Le sostituzioni rapide e i dettagli delle quantità si aprono su richiesta.

**Alimenti** separa Ricette, Porzioni e Impostazioni. La modifica di una ricetta o porzione nasconde temporaneamente la libreria; annullare torna all’elenco senza salvare la bozza. Il riferimento per questa progressione è il flusso di [Cibo Sano](https://gabrirosa.github.io/cibo-sano/), nei moduli `diary-ui.js` e `kitchen-ui.js`. Non cambia il formato dei dati o lo storico dei pasti.

## Ricerca online degli alimenti

Da **Modifica pasto → Aggiungi alimento → Cerca**, scrivere filtra il catalogo locale e le porzioni personali. **Cerca online** o Invio cerca per nome o marca su Open Food Facts; **Altri risultati** carica la pagina successiva. La scelta legge i valori nutrizionali del prodotto e apre la quantità. Se mancano nutrienti, occorre completarli: un campo mancante non diventa zero. Il salvataggio della porzione abituale è facoltativo; il diario cambia solo con **Salva questo pasto**. La ricerca è disponibile anche mentre si compone una ricetta.

[food-search.js](src/food-search.js) usa il proxy pubblico `GET /api/foods/search?q=…&page=…` del Worker Pasti, senza cookie o credenziali. [server/food-search.js](server/food-search.js) chiama soltanto l’endpoint ufficiale Search-a-licious, con campi limitati a codice, nome e marca. La scelta del risultato passa da `lookupProduct` per leggere i nutrienti normalizzati per 100 g/ml. Il proxy serve sia GitHub Pages sia il sito Worker; CORS è ristretto a queste due origini. Non legge D1, sessioni Google, profilo o diario. Il provider non esponeva CORS nelle verifiche HTTP del 27 ottobre 2026, quindi il browser non lo chiama direttamente.

La ricerca è esplicita, senza chiamate durante la digitazione, in accordo con i [limiti Open Food Facts](https://openfoodfacts.github.io/openfoodfacts-server/api/). Il Worker conserva al massimo 100 ricerche pubbliche per cinque minuti e applica un limite indicativo di 10 chiamate upstream al minuto per istanza; non è un limite globale distribuito. Il client mantiene una piccola cache in memoria. Query, pagine, risposte e timeout sono limitati; errori e richieste annullate non producono salvataggi. La copertura dipende dal catalogo Open Food Facts e non comprende necessariamente ogni alimento. Restano disponibili codice a barre e inserimento manuale.

## Olio in cucchiai

Nel diario, nelle ricette e nelle porzioni personali, l’olio si misura in cucchiai con incrementi di 0,25: per esempio 1,25, 1,5 e 1,75. Per il calcolo si usa un cucchiaio indicativo da 13,5 g, oppure 15 ml quando l’etichetta è per volume. Il riferimento di massa è la voce olio d’oliva delle [tabelle USDA](https://www.nal.usda.gov/sites/default/files/page-files/Total_Fat.pdf). La capacità dei cucchiai domestici può variare.

I nuovi piani e gli adattamenti automatici arrotondano l’olio al quarto di cucchiaio e ricalcolano i macro sulla quantità arrotondata. I dati sono conservati in grammi o millilitri per mantenere il formato dei backup. I pasti già salvati restano invariati: quando la dose originale non coincide con un quarto di cucchiaio, la visualizzazione indica «circa». Aprire un pasto o una ricetta in modifica prepara la dose arrotondata; soltanto il salvataggio la applica.

## Dati personali

[storage.js](src/storage.js) salva il profilo, le etichette personalizzate e il diario nella chiave `pasti.data.v1` del `localStorage`. Ogni giorno conserva il profilo e i pasti usati per quella data. Le registrazioni conservano un’istantanea dei valori al momento del consumo: un cambiamento del profilo o delle etichette non riscrive lo storico.

Dopo aver salvato un nuovo deficit o calendario, usa **Applica ai piani da oggi** in Profilo, oppure l’avviso che compare nel diario. La conferma aggiorna gli obiettivi e rigenera i pasti ancora da consumare nei giorni esistenti da oggi in poi; può quindi sostituire porzioni modificate a mano. Conserva i pasti già registrati, i giorni passati e le giornate interamente consumate. I vecchi profili restano leggibili: il precedente deficit del 10% viene mostrato in kcal come proposta al successivo salvataggio.

Il comando **Aggiorna i pasti da oggi in poi**, nella sezione Alimenti, applica il catalogo corrente ai pasti pianificati non ancora consumati, dopo una conferma. Mantiene ingredienti, grammi ed eventuali valori personalizzati; lascia invariati i giorni passati e le registrazioni dei pasti mangiati.

In **Profilo** puoi esportare o importare un backup JSON e cancellare i dati locali. L’importazione valida il file e chiede conferma prima di sostituire l’archivio. Il limite del backup è 5 MiB. Un conflitto fra schede blocca il salvataggio del modello obsoleto e richiede il ricaricamento.

GitHub ospita i file dell’app; il profilo e il diario restano nel browser. Non c’è sincronizzazione automatica tra dispositivi. Cancellare i dati del sito può rimuovere l’archivio, quindi conserva un backup. Il manifest consente l’aggiunta alla schermata Home nei browser compatibili; il caricamento richiede una connessione.

Nella versione GitHub Pages i token e le calorie lette da Google Health rimangono nella memoria della sessione e non entrano nei backup. Le ricevute degli invii vengono invece conservate nel browser, separatamente dal diario: consentono di riconoscere un invio precedente anche dopo una ricarica. Non contengono token o valori nutrizionali e non entrano nei backup del diario. Nella versione GitHub Pages le richieste vanno direttamente a Google. Il [servizio opzionale Cloudflare](docs/persistent-access.md) conserva invece credenziali cifrate per ripristinare l’accesso tra le aperture; è pubblicato su [Pasti con accesso mantenuto](https://pasti.gabri-rosso02.workers.dev/). Consenso personale, lettura e ripristino dopo ricarica e riapertura sono stati verificati in Chrome. Disconnetti chiude la sessione locale; la revoca del consenso si gestisce nelle connessioni dell’account Google. I pasti inviati rimangono su Google Health. Vedi [come vengono usati i dati](privacy.html).

## Calcoli

[nutrition.js](src/nutrition.js) stima l’energia a riposo con Mifflin–St Jeor e applica il fattore di attività e l’obiettivo. Il fattore comprende già corsa, sala attrezzi e movimento quotidiano: il consumo stimato è una media e non aggiunge calorie in base al solo nome dell’allenamento. [training.js](src/training.js) risolve l’attività per una data. [foods.js](src/foods.js) contiene valori nutrizionali e fonti. [planner.js](src/planner.js) compone i pasti e ricalcola tutti i macro quando cambia una porzione, comprese le proteine della pasta di lenticchie.

Il [metodo completo](docs/nutrition.md) documenta formule, fonti e limiti. Le stime si rivolgono ad adulti sani e non sostituiscono una valutazione nutrizionale individuale. I totali dei pasti derivano dagli ingredienti effettivi; possono differire dai riferimenti giornalieri.

## Avvio e controlli

Servi la cartella con un server HTTP; aprire `index.html` come file locale non carica correttamente i moduli ES.

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Apri `http://127.0.0.1:8766/`. Per eseguire i test, usa Node.js 22 o successivo:

```sh
node --test tests/*.test.mjs
```

[domain.test.mjs](tests/domain.test.mjs) verifica calcoli, porzioni e sostituzioni. [activity-import.test.mjs](tests/activity-import.test.mjs) verifica la lettura e l’aggregazione dei CSV. [integration.test.mjs](tests/integration.test.mjs) verifica persistenza e flussi applicativi con DOM e storage in memoria. I test automatici non sostituiscono la verifica visuale del browser.

[google-health.test.mjs](tests/google-health.test.mjs) verifica intervalli italiani, dati delle API, paginazione e gestione degli errori usando risposte sintetiche. Le prove locali non dimostrano che un account Google contenga i dati desiderati: occorre completare il consenso e verificare una lettura reale.

## Pubblicazione

I percorsi dell’app sono relativi, così il sito funziona anche sotto `/pasti/`. GitHub Pages pubblica la radice del ramo `main`; [.nojekyll](.nojekyll) evita la trasformazione dei file. Non è necessario un passaggio di build.

Gli URL di CSS e moduli JavaScript includono una versione per evitare che il browser mescoli file di rilasci diversi. A ogni rilascio che modifica questi file, aggiorna lo stesso parametro `v` in `index.html` e in tutti gli import tra moduli JavaScript.

La cartella `work/` contiene esclusivamente coordinamento e prove locali ed è esclusa da Git. Profilo, diario, backup e credenziali non devono essere aggiunti al repository.

## Versione con accesso persistente

Il build `node scripts/build-worker.mjs` prepara `dist/` per il Worker sullo stesso dominio. Include soltanto gli asset pubblici e l’informativa specifica per la conservazione cifrata delle credenziali. [Configurazione e attivazione gratuita](docs/persistent-access.md). Il build da solo non pubblica il sito e non cambia il collegamento di GitHub Pages.
