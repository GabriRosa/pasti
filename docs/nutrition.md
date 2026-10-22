# Calcoli, alimenti e porzioni

Pasti genera stime per adulti sani e proposte di pasti modificabili. [nutrition.js](../src/nutrition.js) calcola gli obiettivi, [foods.js](../src/foods.js) conserva i valori per 100 g e [planner.js](../src/planner.js) compone le porzioni. I valori del diario derivano sempre dai grammi degli ingredienti, comprese le proteine di pasta, avena e legumi.

## Energia e macronutrienti

`calculateTargets(profile)` usa la forma arrotondata dell’equazione di [Mifflin e collaboratori, 1990](https://doi.org/10.1093/ajcn/51.2.241):

```text
riposo = 10 × peso_kg + 6,25 × altezza_cm − 5 × età_anni + costante
costante = +5 per male, −161 per female
tdee = riposo × fattore_attività
```

Il campo API `bmr` contiene questa stima del dispendio a riposo, non una misurazione del metabolismo basale. Il parametro `sex` rappresenta il sesso biologico utilizzato dai coefficienti della formula; non descrive l’identità di genere. Lo studio originale comprendeva adulti sani di 19–78 anni: a 18 anni e oltre 78 l’app segnala l’estrapolazione.

I fattori di attività sono convenzioni operative dell’app e comprendono già movimento quotidiano e allenamenti. Il numero di giorni selezionati decide la presenza dello spuntino, senza aggiungere calorie al fabbisogno.

| ID attività | Fattore |
| --- | ---: |
| `sedentary` | 1,2 |
| `light` | 1,375 |
| `moderate` | 1,55 |
| `active` | 1,725 |
| `very-active` | 1,9 |

L’obiettivo `maintain` usa il TDEE, `lose` il 90% e `gain` il 105%. Il deficit del 10% e il surplus del 5% sono scelte moderate dell’app, non valori prescritti dall’equazione né promesse di variazione del peso. Gli obiettivi restano uguali nei giorni di riposo.

Le proteine sono impostate a 1,6 g/kg per mantenimento e aumento, a 1,8 g/kg durante il deficit. Sono punti di partenza entro l’intervallo 1,4–2,0 g/kg riportato dalla [posizione ISSN su proteine ed esercizio](https://doi.org/10.1186/s12970-017-0177-8) per la maggior parte degli adulti sani che si allenano. L’app non distingue durata, volume o tipo di allenamento e non stima il fabbisogno di un atleta individuale.

La ripartizione lascia il 30% dell’energia ai grassi e assegna il residuo ai carboidrati. Le proteine sono limitate al 35% dell’energia, con un avviso quando questo limite riduce i grammi per kg. Il 30%, il limite del 35% e la quota residua sono regole di composizione dell’app: non costituiscono target clinici esatti. Per questa sola ripartizione si usano 4 kcal/g per proteine e carboidrati e 9 kcal/g per grassi.

### Controlli sui dati

Il calcolatore accetta età 18–100 anni, peso 35–250 kg e altezza 130–230 cm. Rifiuta numeri mancanti, negativi, non finiti e scelte sconosciute. Questi limiti validano l’input e non garantiscono l’idoneità del piano.

Con `specialCondition: true` il calcolo si interrompe: gravidanza, allattamento, patologie e disturbi alimentari richiedono una valutazione individuale. Con BMI inferiore a 18,5 l’app mostra un avviso e disattiva il deficit; con BMI da 30 segnala i limiti della stima. Il BMI serve qui solo come controllo grossolano, non come diagnosi. Anche risultati sotto 1.500 o sopra 3.500 kcal producono un avviso; queste sono soglie di revisione del software, non minimi o massimi alimentari universali.

## Catalogo e fonti

Tutti i numeri sono riferiti a 100 g di parte edibile. I cereali e la pasta si pesano a secco, carne e pesce a crudo senza scarti, il tonno al naturale dopo averlo sgocciolato. Pane, yogurt, dessert e gallette si pesano come consumati. Olio e cioccolato includono l’intera quantità utilizzata. Acqua di cottura e acqua aggiunta non modificano i nutrienti del prodotto secco; il peso cotto invece cambia.

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

Le tre voci seguenti hanno `estimated: true`. Il nome Lidl identifica la preferenza dell’utente; nessuna delle tre schede rappresenta un’etichetta italiana Lidl verificata.

| ID | Stima per 100 g: kcal / proteine / carboidrati / grassi | Base della stima |
| --- | --- | --- |
| `lentil-pasta-lidl` | 334 / 26 / 50 / 1,7 | [Probios, fusilli 100% lenticchie rosse](https://shop.probios.it/prodotti/piatti-pronti-prepar/pasta/pasta-di-legumi/fusilli-100-lenticchie-rosse.html), prodotto analogo |
| `protein-pudding-lidl` | 76 / 10 / 5,5 / 1,5 | [Ehrmann, pudding al cioccolato](https://shop.ehrmann.de/products/ehrmann-high-protein-pudding-chocolate), riferimento orientativo: il sito mostra una tabella per 100 ml, quindi la trasposizione a 100 g resta una stima |
| `protein-mousse-lidl` | 74 / 10 / 5 / 1,6 | [Ehrmann, Duo Mousse](https://www.ehrmann.de/high-protein-duo-mousse-vanilla-chocolate-flavour/), valori per 100 g di un prodotto analogo |

La confezione effettiva prevale sempre. Anche la porzione da 200 g di budino o mousse è un esempio modificabile; gusto e formato possono differire. Le proteine del dessert non rendono equivalenti tutte le sue varianti.

`getFood(id, overrides)` legge una mappa `id → {kcal, protein, carbs, fat}`. Quando una voce è personalizzata servono tutti e quattro i numeri, finiti e non negativi. Nome, gruppo e fonte restano quelli del catalogo; l’override modifica solo i valori. `foodMacros(id, grams, overrides)` moltiplica ciascun valore per `grams / 100`, senza arrotondamenti intermedi. La fonte originaria resta utile per capire da dove parte la stima, anche quando il diario usa valori personalizzati.

## Giornata e alternative

`createDayPlan(profile, targets, dateKey, overrides)` interpreta la data come giorno di calendario, con domenica uguale a 0. Il parsing usa componenti UTC solo per evitare spostamenti di giorno dovuti al fuso; l’input è la data locale scelta dall’utente. Date impossibili o fuori dall’intervallo 1900–2100 vengono rifiutate.

La stessa data e gli stessi input producono gli stessi piatti. Il giorno seleziona a rotazione una delle cinque colazioni, uno dei tre spuntini e combinazioni diverse per pranzo e cena. Nei giorni di allenamento il preworkout è previsto 15 minuti prima e può essere saltato nell’interfaccia. Per la palestra alle 06:00 gli orari iniziali sono 05:45 e 07:30; la colazione va spostata secondo la fine effettiva della seduta. Con un allenamento da mezzanotte alle 00:14, la nota avverte che lo spuntino cade la sera precedente.

Le colazioni comprendono budino con avena e banana, mousse con pane e confettura, yogurt greco con cioccolato fuso, toast con uova e yogurt, yogurt con avena e banana. Budino e mousse mantengono un vasetto indicativo da 200 g; cambia la quota di cereale d’accompagnamento. Le alternative preworkout sono piccola banana, gallette con confettura, pane con confettura. Sono porzioni da circa 75–90 kcal prima di eventuali override, da adattare alla tolleranza personale.

Per allenamenti dalle 09:00 in poi l’app conserva la colazione alle 08:00 e chiarisce che precede la palestra. Il modello non ricostruisce una giornata sportiva a partire dalla durata di una seduta, che non viene richiesta.

La colazione parte da circa il 27% dell’energia. I nutrienti rimasti dopo colazione e spuntino sono divisi tra pranzo e cena. Le dosi restano entro limiti pratici: 20–150 g per il cereale secco, 80–650 g per patate, 50–300 g per carne o tonno, 60–250 g per salmone, 80–300 g per albumi usati da soli. La proposta con uova usa 100 g senza guscio, circa due uova medie, e albumi solo quando servono. L’olio può arrivare a 30 g per pasto; si riduce con ingredienti più grassi. Le verdure iniziali sono 200 g per pasto principale.

Se al pasto manca più del 4% dell’energia prevista, il calcolo aggiunge pane a parte, fino a un totale di 150 g. Se l’energia supera il riferimento di oltre il 4%, riduce l’olio quando possibile. Il pane contribuisce anche a proteine e carboidrati: le quote dei singoli macro possono quindi differire dagli obiettivi. I limiti delle porzioni restano validi anche quando impediscono di raggiungere la stima calorica.

`mealAlternatives` offre tutte le 30 combinazioni tra cinque carboidrati e sei scelte proteiche per ogni pasto principale. `swapMealFood` ricalcola contemporaneamente la porzione del carboidrato, quella proteica e l’olio, conservando verdure ed eventuali altri ingredienti fissi. L’algoritmo risolve le equazioni di proteine e carboidrati; se la soluzione supera i limiti di porzione, sceglie la soluzione ammissibile con errore relativo minore, dando alle proteine peso 1,5. I grassi già presenti determinano l’olio residuo. L’olio assente è spiegato nella nota, senza ingredienti fittizi da zero grammi.

Per esempio, un pasto con 80 g di pasta di semola, 170 g di pollo, 200 g di verdure e 10 g d’olio contiene 53,41 g di proteine e 61,56 g di carboidrati. Sostituendo la pasta con il riferimento di lenticchie, il calcolo propone 116,32 g di pasta di lenticchie e circa 86,6 g di pollo: la quota proteica dei legumi sostituisce parte del pollo. Tutti e quattro i macro sono poi ricalcolati dagli ingredienti effettivi.

## Test del dominio

[domain.test.mjs](../tests/domain.test.mjs) controlla formula numerica, ripartizione energetica, limiti del profilo, catalogo, personalizzazione delle etichette, calendario, riposo, porzioni e ricalcolo delle sostituzioni. La prova su pasta di lenticchie verifica sia la riduzione del pollo sia il percorso inverso; quella sul salmone verifica anche l’olio. Una matrice di profili e giorni controlla i nutrienti di ogni ingrediente e delle 30 alternative.

```sh
node --test tests/domain.test.mjs
```

Il dominio non verifica allergie, micronutrienti o adeguatezza clinica e non misura il dispendio individuale. Tutte le quantità restano editabili nel diario.
