# Calcoli, alimenti e porzioni

Pasti genera stime per adulti sani e proposte di pasti modificabili. [nutrition.js](../src/nutrition.js) calcola gli obiettivi, [training.js](../src/training.js) determina l’attività del giorno, [foods.js](../src/foods.js) conserva i valori per 100 g e [planner.js](../src/planner.js) compone le porzioni. I valori del diario derivano sempre dai grammi degli ingredienti, comprese le proteine di pasta, avena e legumi.

## Energia e macronutrienti

`calculateTargets(profile)` usa la forma arrotondata dell’equazione di [Mifflin e collaboratori, 1990](https://doi.org/10.1093/ajcn/51.2.241):

```text
riposo = 10 × peso_kg + 6,25 × altezza_cm − 5 × età_anni + costante
costante = +5 per male, −161 per female
tdee = riposo × fattore_attività
```

Il campo API `bmr` contiene questa stima del dispendio a riposo, non una misurazione del metabolismo basale. Il parametro `sex` rappresenta il sesso biologico utilizzato dai coefficienti della formula; non descrive l’identità di genere. Lo studio originale comprendeva adulti sani di 19–78 anni: a 18 anni e oltre 78 l’app segnala l’estrapolazione.

I fattori di attività sono convenzioni operative dell’app e comprendono già movimento quotidiano, corsa e sala attrezzi. Il TDEE è una media giornaliera: il tipo e la presenza dell’allenamento decidono il programma e lo spuntino, senza aggiungere calorie al fabbisogno. Durata e intensità della singola seduta non vengono stimate.

| ID attività | Fattore |
| --- | ---: |
| `sedentary` | 1,2 |
| `light` | 1,375 |
| `moderate` | 1,55 |
| `active` | 1,725 |
| `very-active` | 1,9 |

Il risultato distingue tre numeri: `bmr` è il dispendio a riposo stimato, `tdee` il dispendio totale giornaliero medio, `kcal` l’obiettivo alimentare. Con `goal: 'lose'` e `deficitKcal` esplicito, l’obiettivo è esattamente `tdee - deficitKcal`, senza arrotondamenti intermedi. Un deficit di 0 kcal usa il mantenimento. L’oggetto Targets mantiene gli stessi campi; la differenza `tdee - kcal` mostra il deficit applicato.

`deficitKcal` accetta un numero finito non negativo; stringhe, valori mancanti esplicitamente come `null` e altri tipi vengono rifiutati. Per dimagrimento, un deficit maggiore o uguale al TDEE viene rifiutato. Se il campo è assente, il vecchio profilo conserva il deficit automatico del 10%. `maintain` usa il TDEE e `gain` il 105%: per questi obiettivi un eventuale deficit numericamente valido non viene applicato. Gli obiettivi restano uguali nei giorni di riposo, corsa e sala attrezzi.

Per esempio, con 80 kg, 180 cm, 35 anni, sesso maschile e attività `moderate`, il riposo stimato è 1.755 kcal e il TDEE 2.720,25 kcal. Un deficit scelto di 250 kcal produce 2.470,25 kcal; 500 kcal produce 2.220,25 kcal. Il calcolo non impone un nuovo tetto clinico al deficit: restano gli avvisi per stime caloriche fuori scala e la valutazione individuale quando necessaria.

Le proteine sono impostate a 1,6 g/kg per mantenimento e aumento, a 1,8 g/kg durante un deficit effettivo positivo. Un deficit di 0 usa quindi 1,6 g/kg. Sono punti di partenza entro l’intervallo 1,4–2,0 g/kg riportato dalla [posizione ISSN su proteine ed esercizio](https://doi.org/10.1186/s12970-017-0177-8) per la maggior parte degli adulti sani che si allenano. L’app non assegna fabbisogni diversi alla corsa e alla sala attrezzi e non stima quelli di un atleta individuale.

La ripartizione lascia il 30% dell’energia ai grassi e assegna il residuo ai carboidrati. Le proteine sono limitate al 35% dell’energia, con un avviso quando questo limite riduce i grammi per kg. Il 30%, il limite del 35% e la quota residua sono regole di composizione dell’app: non costituiscono target clinici esatti. Per questa sola ripartizione si usano 4 kcal/g per proteine e carboidrati e 9 kcal/g per grassi.

### Controlli sui dati

Il calcolatore accetta età 18–100 anni, peso 35–250 kg e altezza 130–230 cm. Rifiuta numeri mancanti, negativi, non finiti e scelte sconosciute. Questi limiti validano l’input e non garantiscono l’idoneità del piano.

Con `specialCondition: true` il calcolo si interrompe: gravidanza, allattamento, patologie e disturbi alimentari richiedono una valutazione individuale. Con BMI inferiore a 18,5, un deficit esplicito positivo viene rifiutato con un messaggio che indica il mantenimento e la valutazione individuale; un deficit di 0 resta accettato con avviso. Per compatibilità, un vecchio profilo senza `deficitKcal` continua a ricevere la stima di mantenimento con l’avviso che il deficit automatico è disattivato. Con BMI da 30 viene segnalato il limite della stima. Il BMI serve qui solo come controllo grossolano, non come diagnosi. Anche risultati sotto 1.500 o sopra 3.500 kcal producono un avviso; queste sono soglie di revisione del software, non minimi o massimi alimentari universali.

## Catalogo e fonti

Tutti i numeri sono riferiti a 100 g di parte edibile. I cereali e la pasta secca si pesano a secco; la pasta fresca come venduta prima della cottura. Carne e pesce si pesano a crudo senza scarti, il tonno al naturale dopo averlo sgocciolato. Pane, yogurt, dessert e gallette si pesano come consumati. Olio e cioccolato includono l’intera quantità utilizzata. Acqua di cottura e acqua aggiunta non modificano i nutrienti del prodotto secco; il peso cotto invece cambia.

Fonti consultate il 22–23 ottobre 2026:

| ID | Fonte e riferimento |
| --- | --- |
| `pasta` | [CREA: pasta di semola, 000800](https://www.alimentinutrizione.it/tabelle-nutrizionali/000800) |
| `rice` | [CREA: riso brillato, 000100](https://www.alimentinutrizione.it/tabelle-nutrizionali/000100) |
| `couscous` | [CREA: couscous crudo, 000045](https://www.alimentinutrizione.it/tabelle-nutrizionali/000045) |
| `potatoes` | [CREA: patate crude, 006500](https://www.alimentinutrizione.it/tabelle-nutrizionali/006500) |
| `chicken` | [CREA: petto di pollo crudo, 106500](https://www.alimentinutrizione.it/tabelle-nutrizionali/106500) |
| `eggs` | [CREA: uova intere, 181100](https://www.alimentinutrizione.it/tabelle-nutrizionali/181100) |
| `egg-whites` | [CREA: albume, 182010](https://www.alimentinutrizione.it/tabelle-nutrizionali/182010) |
| `salmon` | [CREA: salmone, 122400](https://www.alimentinutrizione.it/tabelle-nutrizionali/122400) |
| `tuna` | [CREA: tonno in salamoia sgocciolato, 123550](https://www.alimentinutrizione.it/tabelle-nutrizionali/123550) |
| `pork-tenderloin` | [USDA: Fresh Pork, Release 1.1, NDB 10218, tabella a pagina PDF 13](https://www.ars.usda.gov/ARSUserFiles/80400525/Data/Pork/Pork1-1.pdf#page=13): crudo, 128 kcal, 20,65 g proteine, 0 g carboidrati, 3,53 g grassi |
| `olive-oil` | [CREA: olio extravergine, 009210](https://www.alimentinutrizione.it/tabelle-nutrizionali/009210) |
| `vegetables` | [CREA: zucchine crude, 005730](https://www.alimentinutrizione.it/tabelle-nutrizionali/005730), usate come riferimento indicativo per le verdure |
| `banana` | [CREA: banane, 007510](https://www.alimentinutrizione.it/tabelle-nutrizionali/007510) |
| `rice-cakes` | [Catalogo RisoALMO, pagina PDF 10](https://www.risoalmo.it/catalogo-prodotti-almo.pdf#page=10): gallette semplici, 383 kcal, 8,6 g proteine, 78 g carboidrati, 3,3 g grassi |
| `jam` | [CREA: marmellata, 204500](https://www.alimentinutrizione.it/tabelle-nutrizionali/204500) |
| `oats` | [CREA: fiocchi d’avena, 003030](https://www.alimentinutrizione.it/tabelle-nutrizionali/003030) |
| `greek-yogurt` | [CREA: yogurt greco 0%, 150030](https://www.alimentinutrizione.it/tabelle-nutrizionali/150030) |
| `bread` | [CREA: pane integrale, 000550](https://www.alimentinutrizione.it/tabelle-nutrizionali/000550) |
| `dark-chocolate` | [CREA: cioccolato fondente, 203020](https://www.alimentinutrizione.it/tabelle-nutrizionali/203020) |

CREA riporta carboidrati disponibili; le voci `tr` sono rappresentate come zero. L’energia resta quella della fonte, che può usare fattori diversi dalla semplice somma 4/4/9. Fibre, metodo analitico e arrotondamenti spiegano parte delle differenze. Il diario non ricalcola le kcal a partire dai tre macro e non applica correzioni per far coincidere le due cifre.

### Prodotti Lidl e valori da confezione

Le sei voci seguenti hanno `estimated: false` e metadati `label` con data di verifica, peso della confezione, mercato Italia e URL della prova fotografica. Il codice a barre, quando presente, è associato dal record che ospita le foto; non sempre è leggibile nei ritagli. `LIDL_FOOD_IDS` contiene gli ID delle voci con `label` ed è derivato dal catalogo.

| ID | Etichetta per 100 g: kcal / proteine / carboidrati / grassi | Confezione e prova |
| --- | --- | --- |
| `lentil-pasta-lidl` | 335 / 26 / 50 / 1,7 | Combino Bio High Protein, sedanini secchi, 250 g: [etichetta italiana](https://images.openfoodfacts.org/images/products/433/561/914/6440/nutrition_it.8.full.jpg) |
| `lentil-pasta-lidl-fresh` | 259 / 19 / 39 / 1 | Nonna Mia Bio High Protein, fusilli freschi, 200 g: [etichetta italiana](https://images.openfoodfacts.org/images/products/405/648/963/1538/nutrition_it.5.full.jpg) |
| `protein-pudding-lidl` | 83 / 10,1 / 6,5 / 1,5 | Milbona cacao, ricetta Zoma, 200 g: [foto pubblicata da RetailWatch](https://www.retailwatch.it/wp-content/uploads/2025/10/WhatsApp-Image-2025-10-29-at-21.57.44.jpeg), [articolo](https://www.retailwatch.it/mdd-test-budino-proteico-cacao-lidl-vs-penny/) |
| `protein-pudding-lidl-vanilla` | 75 / 10 / 5,2 / 1,5 | Milbona vaniglia, 200 g: [etichetta italiana](https://images.openfoodfacts.org/images/products/405/648/921/6155/nutrition_it.39.full.jpg) |
| `protein-mousse-lidl` | 86 / 10 / 5,8 / 2,2 | Milbona cioccolato, 175 g: [foto multilingue](https://images.openfoodfacts.org/images/products/405/648/972/4070/nutrition_en.161.full.jpg), [scheda italiana concordante](https://www.altroconsumo.it/alimentazione/dolci-al-cucchiaio/comparatore/milbona-lidl-mousse-proteica-gusto-cioccolato/538/115186) |
| `protein-mousse-lidl-vanilla` | 76 / 10 / 5,8 / 1,4 | Milbona vaniglia, 175 g: [etichetta italiana](https://images.openfoodfacts.org/images/products/405/648/975/9096/nutrition_it.51.full.jpg) |

La verifica del 23 ottobre 2026 riguarda le confezioni documentate, non ogni lotto successivo. La ricetta cacao da 83 kcal resta distinta dal budino al cioccolato da 76 kcal presente in altre fonti; il suo barcode è omesso. Le mousse usano 175 g per vasetto e i budini 200 g. Il calcolo parte dai valori per 100 g: la colonna per vasetto può avere arrotondamenti diversi. La pasta fresca si pesa come venduta prima della cottura e non usa valori o grammi del prodotto secco.

`getFood(id, overrides)` legge una mappa `id → {kcal, protein, carbs, fat}`. Quando una voce è personalizzata servono tutti e quattro i numeri, finiti e non negativi. Nome, gruppo, fonte e metadati di etichetta restano quelli del catalogo; l’override modifica solo i valori. `foodMacros(id, grams, overrides)` moltiplica ciascun valore per `grams / 100`, senza arrotondamenti intermedi. La fonte originaria resta visibile anche quando il diario usa valori personalizzati. Il formato dei pasti e dei backup resta invariato.

## Giornata e alternative

### Calendario condiviso degli allenamenti

`trainingForDate(profile, dateKey)` restituisce `{type, label, time}`. I tipi sono `run` (“Corsa”), `strength` (“Sala attrezzi”) e `rest` (“Riposo”). Le attività usano `profile.trainingTime`, oppure le 06:00 se l’orario è assente; per riposo `time` è una stringa vuota. Il calcolo non modifica il profilo e non riscrive gli snapshot del diario.

`validateTrainingPlan(plan)` accetta `undefined` oppure una delle due forme seguenti. Restituisce il piano invariato quando valido e genera un errore leggibile negli altri casi.

```js
// Tutti i giorni: corsa il 23 ottobre, sala il 24, corsa il 25, e così via.
trainingPlan: {
  mode: 'alternating',
  startDate: '2026-10-23',
  firstType: 'run'
}

// Settimana personalizzata, domenica in posizione 0.
trainingPlan: {
  mode: 'weekly',
  days: ['rest', 'run', 'strength', 'run', 'strength', 'run', 'strength']
}
```

L’alternanza usa la differenza tra giorni di calendario UTC, per evitare effetti dell’ora legale. Prosegue attraverso domenica/lunedì, mesi e anni e funziona anche prima della data di riferimento: un giorno prima usa il tipo opposto, due giorni prima lo stesso tipo. Date di riferimento e date richieste devono essere reali e comprese tra 1900 e 2100. La settimana personalizzata richiede esattamente sette tipi validi.

Quando `trainingPlan` è presente, determina l’attività; `trainingDays` resta il campo compatibile con i vecchi profili. In assenza del piano, i giorni di `trainingDays` vengono interpretati come sala attrezzi e gli altri come riposo. L’interfaccia deriva `trainingDays` dai giorni attivi quando salva un nuovo piano. Il planner usa lo stesso helper dell’interfaccia per evitare calendari divergenti.

`createDayPlan(profile, targets, dateKey, overrides)` interpreta la data come giorno di calendario, con domenica uguale a 0. Il parsing usa componenti UTC solo per evitare spostamenti di giorno dovuti al fuso; l’input è la data locale scelta dall’utente. Date impossibili o fuori dall’intervallo 1900–2100 vengono rifiutate.

La stessa data e gli stessi input producono gli stessi piatti. Il giorno seleziona a rotazione una delle sette colazioni, uno dei tre spuntini e combinazioni diverse per pranzo e cena. Nei giorni di corsa o sala attrezzi il preworkout è previsto 15 minuti prima e può essere saltato nell’interfaccia. Per l’allenamento alle 06:00 gli orari iniziali sono 05:45 e 07:30; la colazione va spostata secondo la fine effettiva della seduta. Con un allenamento da mezzanotte alle 00:14, la nota avverte che lo spuntino cade la sera precedente.

Le colazioni comprendono i due gusti di budino con avena e banana, i due gusti di mousse con pane e confettura, yogurt greco con cioccolato fuso, toast con uova e yogurt, yogurt con avena e banana. Ogni dessert usa `label.packGrams` per il vasetto; cambia la quota di cereale d’accompagnamento. Le alternative preworkout sono piccola banana, gallette con confettura, pane con confettura. Sono porzioni da circa 75–90 kcal prima di eventuali override, da adattare alla tolleranza personale.

Per allenamenti dalle 09:00 in poi l’app conserva la colazione alle 08:00 e chiarisce che precede l’allenamento. Il modello non ricostruisce una giornata sportiva a partire dalla durata di una seduta, che non viene richiesta.

La colazione parte da circa il 27% dell’energia. Pranzo riceve metà dei nutrienti rimasti; cena parte dal residuo effettivo dopo pranzo. Se un pasto non può raggiungere l’energia prevista, il generatore prova a distribuire il residuo nell’altro, mantenendo il vincolo proteico. Se resta una differenza calorica oltre il 5%, prova un altro carboidrato tra quelli disponibili. Questa scelta riguarda il piano iniziale; tutte le combinazioni restano selezionabili.

Le dosi restano entro limiti pratici: 20–150 g per il cereale secco, 50–300 g per pasta fresca di lenticchie, 80–650 g per patate, 50–300 g per carne o tonno, 60–250 g per salmone, 80–300 g per albumi usati da soli. La proposta con uova usa 100 g senza guscio, circa due uova medie, e albumi solo quando servono. Pane fino a 150 g e olio fino a 30 g sono componenti del calcolo, non aggiunte successive. Le verdure iniziali sono 200 g per pasto principale.

`mealAlternatives` offre tutte le 36 combinazioni tra sei carboidrati e sei scelte proteiche per ogni pasto principale. `swapMealFood` ricalcola carboidrato, secondo, pane e olio, conservando verdure ed eventuali altri ingredienti fissi. La quota proteica del pasto è un vincolo, comprendente ogni ingrediente. Il primo passaggio cerca di conservare anche i carboidrati usando la minore quantità di pane necessaria. Se l’energia resta fuori da un intervallo del 4%, adatta prima l’olio, quando basta; altrimenti risolve di nuovo il pasto conservando proteine ed energia e riducendo lo scostamento di carboidrati e grassi.

Se il target proteico è fuori da quanto consentono le porzioni minime e massime, il calcolo usa il valore ammissibile più vicino e indica nella nota proteine effettive e obiettivo, senza dichiarare equivalenza. Gli ingredienti da zero grammi vengono omessi. Anche nei cambi consecutivi il pane viene ricalcolato come componente adattabile: non si accumulano righe duplicate o porzioni oltre 150 g.

Per esempio, un pasto con 80 g di pasta di semola, 170 g di pollo, 200 g di verdure e 10 g d’olio contiene 53,41 g di proteine e 61,56 g di carboidrati. Sostituendo la pasta con il riferimento di lenticchie, il calcolo propone 116,32 g di pasta di lenticchie e circa 86,6 g di pollo: la quota proteica dei legumi sostituisce parte del pollo. Tutti e quattro i macro sono poi ricalcolati dagli ingredienti effettivi.

## Test del dominio

[domain.test.mjs](../tests/domain.test.mjs) controlla formula numerica, ripartizione energetica, limiti del profilo, catalogo, personalizzazione delle etichette, calendario, riposo, porzioni e ricalcolo delle sostituzioni. Le prove su pasta secca e fresca di lenticchie verificano la riduzione del pollo, le proteine del pane e cambi consecutivi; quella sul salmone verifica anche l’olio. Una matrice di profili e giorni controlla i nutrienti di ogni ingrediente e delle 36 alternative. Una seconda matrice verifica uno scostamento calorico entro il 5% in 168 scenari ordinari.

I test sul deficit coprono 0, 250, 500 kcal, numeri non validi, soglia TDEE, sottopeso e retrocompatibilità. Quelli sull’allenamento coprono alternanza, giorni precedenti al riferimento, domenica/lunedì, fine mese, cambio d’anno, bisestile, ora legale e identità dei macro fra corsa e sala attrezzi. Gli import dei moduli del dominio usano la versione asset `v=20261023-deficit`.

```sh
node --test tests/domain.test.mjs
```

Il dominio non verifica allergie, micronutrienti o adeguatezza clinica e non misura il dispendio individuale. Tutte le quantità restano editabili nel diario.
