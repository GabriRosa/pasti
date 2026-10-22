# Pasti

Pasti è un diario alimentare in italiano che genera proposte giornaliere dai dati del profilo e permette di modificare alimenti e quantità. È un’app statica, senza dipendenze di runtime, pensata per GitHub Pages e per l’uso dal telefono.

## Uso

Al primo accesso inserisci età, peso, altezza, sesso usato nella formula, attività abituale e obiettivo. Il profilo mostra la stima del consumo a riposo, il consumo giornaliero medio e l’obiettivo calorico. Per perdere peso scegli il deficit in kcal: l’obiettivo è il consumo medio meno il valore inserito. Il valore zero mantiene le calorie stimate di mantenimento.

L’orario iniziale degli allenamenti è 06:00. Puoi alternare corsa e sala attrezzi ogni giorno, scegliendo una data di riferimento e la prima attività, oppure assegnare corsa, sala attrezzi o riposo ai giorni della settimana. L’alternanza prosegue anche tra settimane e mesi. Il piano distingue uno spuntino facoltativo prima dell’allenamento dalla colazione successiva; seguono pranzo e cena.

Il diario mostra obiettivo stimato, quantità pianificate e quantità consumate. Apri **Modifica porzioni e alternative** per cambiare un pasto o i grammi, poi **Segna mangiato** per registrarlo. La registrazione si può annullare. I giorni futuri si possono pianificare; la registrazione diventa disponibile dalla data scelta.

Le alternative comprendono i carboidrati richiesti (pasta, riso, couscous, patate e pasta di lenticchie), pollo, uova, albumi, salmone, tonno e filetto di maiale. Le colazioni includono budino e mousse proteici, yogurt greco con cioccolato fuso e altre proposte.

Le schede Lidl identificano le confezioni verificate: sedanini secchi Combino, fusilli freschi Nonna Mia, budini Milbona cacao e vaniglia da 200 g, mousse Milbona cioccolato e vaniglia da 175 g. In **Alimenti** trovi i valori per 100 g, la data di verifica e il collegamento alla fotografia dell’etichetta. Ogni voce si riferisce alla variante indicata; la modifica manuale è facoltativa per confezioni diverse. La pasta fresca si pesa prima della cottura, senza convertirla in peso secco.

Quando cambi il carboidrato di pranzo o cena, il piano adatta anche carne, pesce o uova e mostra le porzioni prima e dopo la scelta. Le proteine della pasta di lenticchie e degli altri ingredienti contribuiscono già al totale.

## Dati personali

[storage.js](src/storage.js) salva il profilo, le etichette personalizzate e il diario nella chiave `pasti.data.v1` del `localStorage`. Ogni giorno conserva il profilo e i pasti usati per quella data. Le registrazioni conservano un’istantanea dei valori al momento del consumo: un cambiamento del profilo o delle etichette non riscrive lo storico.

Dopo aver salvato un nuovo deficit o calendario, usa **Applica ai piani da oggi** in Profilo, oppure l’avviso che compare nel diario. La conferma aggiorna gli obiettivi e rigenera i pasti ancora da consumare nei giorni esistenti da oggi in poi; può quindi sostituire porzioni modificate a mano. Conserva i pasti già registrati, i giorni passati e le giornate interamente consumate. I vecchi profili restano leggibili: il precedente deficit del 10% viene mostrato in kcal come proposta al successivo salvataggio.

Il comando **Aggiorna i pasti da oggi in poi**, nella sezione Alimenti, applica il catalogo corrente ai pasti pianificati non ancora consumati, dopo una conferma. Mantiene ingredienti, grammi ed eventuali valori personalizzati; lascia invariati i giorni passati e le registrazioni dei pasti mangiati.

In **Profilo** puoi esportare o importare un backup JSON e cancellare i dati locali. L’importazione valida il file e chiede conferma prima di sostituire l’archivio. Il limite del backup è 5 MiB. Un conflitto fra schede blocca il salvataggio del modello obsoleto e richiede il ricaricamento.

GitHub ospita i file dell’app; il profilo e il diario restano nel browser. Non c’è sincronizzazione automatica tra dispositivi. Cancellare i dati del sito può rimuovere l’archivio, quindi conserva un backup. Il manifest consente l’aggiunta alla schermata Home nei browser compatibili; il caricamento richiede una connessione.

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

[domain.test.mjs](tests/domain.test.mjs) verifica calcoli, porzioni e sostituzioni. [integration.test.mjs](tests/integration.test.mjs) verifica persistenza e flussi applicativi con DOM e storage in memoria. I test automatici non sostituiscono la verifica visuale del browser.

## Pubblicazione

I percorsi dell’app sono relativi, così il sito funziona anche sotto `/pasti/`. GitHub Pages pubblica la radice del ramo `main`; [.nojekyll](.nojekyll) evita la trasformazione dei file. Non è necessario un passaggio di build.

Gli URL di CSS e moduli JavaScript includono una versione per evitare che il browser mescoli file di rilasci diversi. A ogni rilascio che modifica questi file, aggiorna lo stesso parametro `v` in `index.html` e in tutti gli import tra moduli JavaScript.

La cartella `work/` contiene esclusivamente coordinamento e prove locali ed è esclusa da Git. Profilo, diario, backup e credenziali non devono essere aggiunti al repository.
