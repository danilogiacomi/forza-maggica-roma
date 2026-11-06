# Forza Maggica Roma

Sito di tifosi (non ufficiale) con le notizie sulla Roma: campionato, coppe, mercato e tifosi,
più prossima partita con conto alla rovescia, risultati, forma e classifiche.

- **Statico**: gira su GitHub Pages, nessun server da mantenere.
- **PWA**: installabile sul telefono, si apre anche offline con le ultime notizie salvate.
- **Notizie scaricate dal dispositivo dell'utente**: i feed RSS vengono letti dal browser tramite
  [rss2json](https://rss2json.com) (con proxy di riserva). Partite e classifiche arrivano dalle API pubbliche ESPN.

## Fonti
Forzaroma.info, Vocegiallorossa, RomaNews, Siamo la Roma, Corriere dello Sport (sezione Roma),
Google News (ricerche per campionato, coppe, mercato, tifosi), ESPN.

Le fonti si cambiano nell'array `SOURCES` in `js/app.js`.
Dopo ogni modifica ai file, incrementare `VERSION` in `sw.js` perché i telefoni scarichino la nuova versione.

Daje Roma!
