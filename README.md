# Rift Scan

A phone web app that scans Riftbound cards with the camera and exports a CSV you can import into your [Piltover Archive](https://piltoverarchive.com) collection.

Everything runs in the browser. There's no server, and your scanned list stays on your phone until you export it.

## Using it

1. Open the site and tap **Start camera**. Allow camera access.
2. Keep the box empty for a moment while it reads "Hold still with the box empty". The scanner learns what the empty table looks like.
3. Slide a card into the box so it fills the outline, then let go. When the card settles, the scanner reads it, beeps, and adds it.
4. Slide the next card in, either over the last one or after taking the last one out.
5. Tap **Export CSV** and save the file. On Piltover Archive, import it into your collection.

To count two copies of the same card, take the first one out before you slide in the second. If you slide the same card over itself, it looks like one card that got nudged, so it's only counted once. You can also tap **+** in the list.

### Fixing mistakes

- **Undo** removes the last card added.
- **Printing** changes the last card to another printing of the same card, such as alternate art or signed.
- **Foil** switches the last card between foil and non-foil. Cards printed only one way lock this setting.
- To add a card by hand, type its name or number, such as `OGN-042`.
- Use **−** and **+** in the list to change any count.

### When a card won't read

The scanner reads the collector number in the bottom-left corner (`OGN • 042/298`). If that fails, it tries the card name. For better reads:

- Use even light and avoid glare on the bottom-left corner.
- Fill the outline with the card.
- If auto-detect misfires, turn it off and tap **Scan now** for each card.
- If the scanner keeps seeing a card that isn't there, clear the box and tap **Box is empty**.

**Detection details** shows the motion numbers and the text the reader saw.

## How it works

| File | What it does |
|---|---|
| `motion.js` | Watches the scan box at 10 fps in 48×64 grayscale. A new card is scanned when the box stops moving and looks different from both the empty background and the last card scanned. |
| `ocr.js` | Runs [Tesseract.js](https://github.com/naptha/tesseract.js) on the number corner, then on the name area, then on the side edge (battlefields are printed sideways). |
| `recognize.js` | Turns OCR text into a card: fixes common misreads (`O`→`0`, `l`→`1`), matches names by the tallest text. |
| `csv.js` | Writes Piltover Archive's collection CSV format. |
| `cards.json` | Every card variant from Piltover Archive (1,275 as of September 2026). |

## Development

```bash
npm install
npm test                     # unit tests
node test/ocr-eval.mjs 30    # OCR accuracy on simulated camera shots of real cards
node test/e2e.mjs            # full app in Chrome with a fake camera video
npm run build-cards          # refresh cards.json when a new set comes out
npm run serve                # http://localhost:8080 (camera works on localhost)
```

The iPhone camera only works over HTTPS, so host the site on GitHub Pages or another HTTPS host to use it on a phone.
