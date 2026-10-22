# Pasti

Pasti è un diario alimentare in italiano che genera proposte giornaliere dai dati del profilo e permette di modificare alimenti e quantità. È un’app statica, senza dipendenze di runtime, pensata per GitHub Pages e per l’uso dal telefono.

## Uso

Al primo accesso inserisci età, peso, altezza, sesso usato nella formula, attività abituale, obiettivo e giorni di allenamento. L’orario iniziale della palestra è 06:00. Nei giorni selezionati il piano distingue uno spuntino facoltativo prima dell’allenamento dalla colazione successiva; seguono pranzo e cena.

Il diario mostra obiettivo stimato, quantità pianificate e quantità consumate. Apri **Modifica porzioni e alternative** per cambiare un pasto o i grammi, poi **Segna mangiato** per registrarlo. La registrazione si può annullare. I giorni futuri si possono pianificare; la registrazione diventa disponibile dalla data scelta.

Le alternative comprendono i carboidrati richiesti (pasta, riso, couscous, patate e pasta di lenticchie), pollo, uova, albumi, salmone, tonno e filetto di maiale. Le colazioni includono budino e mousse proteici, yogurt greco con cioccolato fuso e altre proposte.

Le schede Lidl partono da **stime di prodotti analoghi**, non da etichette Lidl verificate. In **Alimenti** puoi trascrivere i valori per 100 g della confezione; nel pasto puoi impostare il peso del vasetto. I pesi sono della parte edibile a crudo o secco, salvo le note del singolo alimento.

## Dati personali

[storage.js](src/storage.js) salva il profilo, le etichette personalizzate e il diario nella chiave `pasti.data.v1` del `localStorage`. Ogni giorno conserva il profilo e i pasti usati per quella data. Le registrazioni conservano un’istantanea dei valori al momento del consumo: un cambiamento del profilo o delle etichette non riscrive lo storico.

In **Profilo** puoi esportare o importare un backup JSON e cancellare i dati locali. L’importazione valida il file e chiede conferma prima di sostituire l’archivio. Il limite del backup è 5 MiB. Un conflitto fra schede blocca il salvataggio del modello obsoleto e richiede il ricaricamento.

GitHub ospita i file dell’app; il profilo e il diario restano nel browser. Non c’è sincronizzazione automatica tra dispositivi. Cancellare i dati del sito può rimuovere l’archivio, quindi conserva un backup. Il manifest consente l’aggiunta alla schermata Home nei browser compatibili; il caricamento richiede una connessione.

## Calcoli

[nutrition.js](src/nutrition.js) stima l’energia a riposo con Mifflin–St Jeor e applica il fattore di attività e l’obiettivo. [foods.js](src/foods.js) contiene valori nutrizionali e fonti. [planner.js](src/planner.js) compone i pasti e ricalcola tutti i macro quando cambia una porzione, comprese le proteine della pasta di lenticchie.

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

La cartella `work/` contiene esclusivamente coordinamento e prove locali ed è esclusa da Git. Profilo, diario, backup e credenziali non devono essere aggiunti al repository.
