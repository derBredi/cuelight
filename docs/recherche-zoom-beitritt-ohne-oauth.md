# Beitritt ohne OAuth? Recherche zu ZoomMtg.join, OBF-Token und Secure Context

Stand der Recherche: 25. September 2026. Bezug: CueLight, Zoom Meeting SDK für Web 6.2.0, Client View (`ZoomMtg`).

Quellenpolitik dieser Datei: ausschließlich Zooms eigene Entwicklerdokumentation (developers.zoom.us), Zooms eigene Repositories unter github.com/zoom, die vom SDK ausgelieferten Typdefinitionen (`@zoom/meetingsdk`) sowie Beiträge im Zoom Developer Forum, bei denen Zoom-Mitarbeiter antworten. Keine Blogs Dritter, keine Zweitverwertung.

---

## Die kurze Antwort in drei Sätzen

Ja, es geht ohne OAuth — aber nur dann, wenn das Meeting demselben Zoom-Konto gehört, in dem die Meeting-SDK-App angelegt ist; in diesem Fall genügt laut Zoom die SDK-JWT-Signatur allein, und `obfToken` ist ausdrücklich nicht erforderlich. Gehört das Meeting einem **anderen** Konto, verlangt Zoom seit dem 2. März 2026 zwingend eine Zuordnung zu einem Nutzer, also entweder ein OBF-Token oder ein ZAK-Token — und beide setzen den vollen OAuth-Weg voraus, das OBF-Token zusätzlich eine bestandene App-Prüfung durch Zoom. Damit ist die Entscheidung keine technische, sondern eine organisatorische: Wird die CueLight-App in demselben Zoom-Konto angelegt, aus dem die Versammlung ihre Meetings startet, entfallen OAuth, Redirect-URL, Scopes und die Freigabe durch den Host vollständig, und es bleiben Client ID und Client Secret allein zur Signaturerzeugung.

---

## Frage 1 — Die Parameter von `ZoomMtg.join`

### Verbindlichste Quelle: die ausgelieferten Typdefinitionen

Die genaueste und verbindlichste Fassung steht in der Typdeklaration des npm-Pakets `@zoom/meetingsdk` selbst (hier 6.2.0). Sie ist Zooms eigener Auslieferungsstand und deckungsgleich mit der TypeDoc-Referenz.

Quelle: <https://cdn.jsdelivr.net/npm/@zoom/meetingsdk@6.2.0/index.d.ts>
Gerenderte Referenz: <https://marketplacefront.zoom.us/sdk/meeting/web/functions/ZoomMtg.join.html>

| Parameter | Typ | Pflicht laut Zoom | Dokumentierter Zweck (Zooms Wortlaut) |
|---|---|---|---|
| `meetingNumber` | `string \| number` | **Pflicht** | „Required, the Zoom meeting or webinar number." |
| `userName` | `string` | **Pflicht** | „Required. The name of the user starting or joining the meeting or webinar." |
| `signature` | `string` | **Pflicht** | „Required. The signature to start or join a meeting. … As of v5.0.0, the signature requires the appKey field `appKey:sdkKey` or `appKey:clientId`. If not contain appKey, can't join meeting." |
| `success` | `Function` | **Pflicht** | „Callback function on success." |
| `error` | `Function` | **Pflicht** | „Callback function in the event of an error." |
| `passWord` | `string` | im Typ optional, im Kommentar als „Required" bezeichnet | „Required. The meeting's password. Leave as an empty string if the meeting or webinar only requires the waiting room." |
| `userEmail` | `string` | bedingt | „Required for webinar. Required for meeting if registration is required; optional if not." |
| `tk` | `string` | bedingt | „Required if registration is required; optional if not. The registrant's token." |
| `zak` | `string` | bedingt | „Required for hosts starting a meeting or webinar; optional otherwise. The host's Zoom Access Key (ZAK) token." |
| `customerKey` | `string` | optional | „An identifier for the user that you can get back from the Meeting API. Max length 36 char." |
| `recordingToken` | `string` | optional | „Token to allow local recording." Verweist auf den API-Endpunkt für den Local-Recording-Join-Token. |
| `childToken` | `string` | optional | „Optional. childToken." — mehr dokumentiert Zoom nicht. |
| `obfToken` | `string` | optional | „Optional. obfToken." — **mehr dokumentiert Zoom in der Referenz nicht.** |
| `sdkKey` | `string` | **veraltet** | „We remove sdkKey from join params since v4.0.0. You can just use signature." Ausdrücklich `@deprecated`. |

`leaveUrl` gehört **nicht** zu `join`, sondern zu `ZoomMtg.init`. Das zeigt auch Zooms eigenes Codebeispiel für die Client View: <https://developers.zoom.us/docs/meeting-sdk/web/client-view/meetings-webinars/>

```javascript
ZoomMtg.init({
    leaveUrl: leaveUrl,
    success: (success) => {
        ZoomMtg.join({
            signature: signature,
            meetingNumber: meetingNumber,
            passWord: passWord,
            userName: userName,
            userEmail: userEmail,
            zak: zakToken,
            success: (success) => { console.log(success); },
            error: (error) => { console.log(error); },
        });
    },
    error: (error) => { console.log(error); },
});
```

Bemerkenswert: Zooms offizielles Beispiel für den Beitritt enthält **kein** `obfToken`.

### Gibt es `obfToken` überhaupt in der offiziellen Referenz?

Ja — aber praktisch unbeschrieben. In der API-Referenz und in den Typdefinitionen steht als gesamte Erklärung „Optional. obfToken." Was das Token bedeutet, wann es gebraucht wird und wo es herkommt, steht **nicht** in der Parameterreferenz, sondern nur in den Konzept- und Policy-Seiten:

- <https://developers.zoom.us/docs/meeting-sdk/auth/> — „On Behalf Of tokens enable apps to join meetings as individual users outside the developer's account", abgerufen über `GET https://api.zoom.us/v2/users/{userId}/token?type=onbehalf`, Gültigkeit 2 Stunden.
- <https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/> (Zooms eigener Entwickler-Blog, daher als Primärquelle gewertet) — das OBF-Token ist „a short-lived, single-use token retrieved with a REST API" und „allows third-party apps to join a meeting and associate to a specific user in the meeting's participant list."
- <https://github.com/zoom/zoom-plugin/blob/main/skills/meeting-sdk/references/bot-authentication.md> (Zooms eigenes Repository) — „zak and obfToken are **mutually exclusive**. Use only one." Das ist die einzige gefundene ausdrückliche Aussage zur gegenseitigen Ausschließlichkeit der beiden Felder.

Weiterhin dokumentiert Zoom zum OBF-Token eine Verhaltensbedingung, die für CueLight praktisch bedeutsam ist:

> „OBF apps can only join a meeting once their verified associated owner is in a meeting or webinar, and must leave a meeting or webinar when their owner leaves."
> — <https://developers.zoom.us/docs/meeting-sdk/auth/>

Das heißt: Mit OBF-Token hängt CueLight an der Anwesenheit desjenigen, der die App freigegeben hat — verlässt dieser Nutzer das Meeting, muss CueLight es ebenfalls verlassen. Mit reiner Signatur (eigenes Konto) gibt es diese Kopplung nicht.

---

## Frage 2 — Reicht eine Signatur mit `role=0` für ein Meeting eines fremden Kontos?

### Nein. Zoom unterscheidet ausdrücklich zwischen eigenem und fremdem Konto.

Die zentrale Tabelle steht in Zooms FAQ zur geänderten Meeting-SDK-Autorisierung: <https://developers.zoom.us/docs/meeting-sdk/obf-faq/>

| Fall | Von Zoom verlangte Token |
|---|---|
| Als Zoom-Nutzer starten oder beitreten | JWT **+ ZAK** |
| Beitreten **innerhalb** des App-eigenen Kontos | **nur JWT** |
| Beitreten **außerhalb** des App-eigenen Kontos | JWT **+ OBF** |

Dieselbe Trennung steht in der Autorisierungsdokumentation (<https://developers.zoom.us/docs/meeting-sdk/auth/>): ein JWT allein erlaubt den Beitritt „within the app owner's account" als Teilnehmer; für Meetings außerhalb verlangt Zoom App-Review **und** ZAK oder OBF:

> „To join meetings outside of your developer account, your app must: Be reviewed by Zoom. Authenticate with either a ZAK or On Behalf Of (OBF) token to attribute to a user in a meeting."

Und im Änderungsprotokoll, unmissverständlich für den umgekehrten Fall:

> „If you are using the Meeting SDK to join meetings on your own account, no change is needed."
> — <https://developers.zoom.us/changelog/meeting-sdk/requiring-authorization-for-meetings-joined-outside-of-an-apps-account/>

Der Blogbeitrag formuliert es ebenso: „this is only required to join meetings outside the user's Zoom account. Meeting SDK apps that join meetings on a user's same account can (but are not required to) use the On Behalf Of token." (<https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/>)

### Die Regeln haben sich tatsächlich geändert — hier die belegten Daten

- **Anonymer Beitritt in fremde Konten endet.** Zooms Änderungsprotokoll nannte zunächst den **23. Februar 2026**: Ab dann können Meeting-SDK-Apps Meetings außerhalb des eigenen Kontos nicht mehr anonym betreten, sondern müssen sich einem Nutzer zuordnen — über OBF-Token, ZAK-Token oder RTMS. <https://developers.zoom.us/changelog/meeting-sdk/requiring-authorization-for-meetings-joined-outside-of-an-apps-account/>
- **Verschoben auf den 2. März 2026.** Die FAQ hält fest, dass die Durchsetzung verschoben wurde („The original February 23 deadline was extended based on developer feedback"). <https://developers.zoom.us/docs/meeting-sdk/obf-faq/> — dieselbe Datumsangabe auf der Übersichtsseite: „Beginning March 2, 2026, apps joining meetings outside their account must be authorized." <https://developers.zoom.us/docs/meeting-sdk/>
- Dieses Datum liegt zum Zeitpunkt dieser Recherche (September 2026) in der Vergangenheit. Die Regel gilt also bereits.
- **Mindestversionen für OBF:** SDK ab 5.17.5; ab 6.6.10 (November 2025) mit verbesserten OBF-Fehlermeldungen. <https://developers.zoom.us/docs/meeting-sdk/obf-faq/> — CueLight läuft auf 6.2.0, also: OBF grundsätzlich unterstützt, aber ohne die verbesserten Fehlermeldungen.

### Einschränkung bei einer nicht veröffentlichten (development/unpublished) App

Das ist die härteste Schranke, und sie gilt unabhängig von der Token-Frage:

> „Meeting SDK apps now require review to join meetings outside their own account."

Zoom verlangt eine App-Prüfung, um „access meetings outside of the developer account used to create it." Apps können Meetings **im eigenen Entwicklerkonto ohne jede Prüfung** betreten.
<https://developers.zoom.us/changelog/platform/meeting-sdk-policy-announcement/> und <https://developers.zoom.us/docs/distribute/sdk-feature-review-requirements/>

Zoom empfiehlt dort, die App „at least a month before your deadline" einzureichen.

Bestätigt von Zoom-Mitarbeitern im Developer Forum (<https://devforum.zoom.us/t/unpublished-zoom-sdk-app-to-join-public-meetings/95899>):

- Donte (Zoom): „If the meeting is in a different account, you will need to submit your Meeting SDK app to the Marketplace."
- Chun Siong (Zoom): auch für Prototypen und nicht-produktive Anwendungen sei die Einreichung nötig; zugleich bedeute „publishing/submitting for approval doesn't necessarily mean that your Meeting SDK App is available for public to use" — eine geprüfte App kann also „unlisted" bleiben.

Für Beta- und private Apps gibt es einen Zwischenweg: die Autorisierungs-URL darf nach Freigabe mit externen Hosts geteilt werden. <https://developers.zoom.us/docs/distribute/sharing-private-and-beta-apps/>

**Zwischenfazit Frage 2:** Eine Signatur mit `role=0` allein reicht nur für Meetings **desselben** Kontos. Für fremde Konten braucht es (a) App-Review durch Zoom **und** (b) OBF- oder ZAK-Token — also den vollen OAuth-Weg. Es gibt keinen belegten Weg, mit einer unveröffentlichten App einem fremden Meeting beizutreten.

---

## Frage 3 — Wofür `zak`, wofür `tk`, wofür das On-Behalf-Token?

### `zak` — Zoom Access Key: repräsentiert eine **Person**

- Abruf: `GET https://api.zoom.us/v2/users/{userId}/token?type=zak`
- Gültigkeit: 2 Stunden für normale Nutzer; 90 Tage für per `custCreate` angelegte API-Nutzer.
- Zweck: „authenticates a Zoom user in the SDK, allowing them to join meetings with their full Zoom identity."
- Zwingend, wenn:
  - ein Meeting **gestartet** statt nur betreten wird (zusammen mit `role: 1` in der Signatur),
  - eine **Anmeldung erzwungen** ist (Einstellung „Only Authenticated Users Can Join").
- Quellen: <https://developers.zoom.us/docs/meeting-sdk/auth/>, <https://developers.zoom.us/docs/meeting-sdk/web/component-view/meetings-webinars/>, <https://github.com/zoom/zoom-plugin/blob/main/skills/meeting-sdk/references/bot-authentication.md>
- Zooms eigenes Repository stellt ausdrücklich klar, dass **irgendein** Zoom-Konto ein brauchbares ZAK liefert („Any Zoom account's ZAK works") — es muss nicht das ZAK eines Meeting-Teilnehmers sein; ein Dienstkonto reicht. <https://github.com/zoom/zoom-plugin/blob/main/skills/meeting-sdk/references/bot-authentication.md>
- **Aber:** Auch ZAK ist nicht ohne OAuth zu haben. Die FAQ sagt für die nötigen Scopes: „each user must still connect their Zoom account to your app via OAuth before a token can be issued." <https://developers.zoom.us/docs/meeting-sdk/obf-faq/> — benötigte Scopes laut Zoom: „View a user's zak token" (user-managed) bzw. „View all user information" (admin-managed). <https://developers.zoom.us/docs/meeting-sdk/get-credentials/>

### `tk` — Registrierungstoken: repräsentiert eine **Anmeldung**

- Zwingend, wenn das Meeting oder Webinar **Registrierung verlangt**; sonst optional.
- Herkunft: der `tk`-Query-Parameter aus der `join_url` des Registranten, wie sie die Register-API zurückgibt (`"join_url": "https://example.zoom.us/w/12345?tk=TOKEN"`).
- Quellen: <https://developers.zoom.us/docs/meeting-sdk/web/component-view/meetings-webinars/>, Typdefinition `@zoom/meetingsdk`.
- Bei Registrierungspflicht ist zusätzlich `userEmail` erforderlich.

### `obfToken` — On Behalf Of: repräsentiert die **App**, zugeordnet zu einer Person

- Abruf: `GET https://api.zoom.us/v2/users/me/token?type=onbehalf&meeting_id={meeting}`, autorisiert mit dem OAuth-Access-Token des Nutzers; benötigter Scope: `user:read:token`. Gültigkeit 2 Stunden, „single-use".
- Zweck laut FAQ: „ZAK tokens represent a person" — für authentifizierte Nutzer; „OBF tokens represent an app" — für automatisierte Teilnehmer wie Aufzeichnungs-Bots. Das ist der Fall von CueLight.
- Zwingend seit dem 2. März 2026 für Beitritte in **fremde** Konten (Alternative: ZAK oder RTMS).
- Nicht erforderlich für Beitritte im **eigenen** Konto (dort ausdrücklich erlaubt, aber nicht verlangt).
- Kopplung an die Anwesenheit des freigebenden Nutzers (siehe Frage 1).
- Quellen: <https://developers.zoom.us/docs/meeting-sdk/obf-faq/>, <https://developers.zoom.us/docs/meeting-sdk/auth/>, <https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/>

### Zuordnung Meeting-Einstellung → benötigtes Token

| Meeting-Einstellung | Was zwingend wird | Beleg |
|---|---|---|
| Nichts Besonderes, Meeting im **eigenen** Konto | nur Signatur (JWT), `role=0` | FAQ-Tabelle, <https://developers.zoom.us/docs/meeting-sdk/obf-faq/> |
| Meeting in **fremdem** Konto | OBF **oder** ZAK — plus App-Review | FAQ, Changelog, Policy-Announcement |
| **Registrierung erforderlich** | `tk` **und** `userEmail` | Typdefinition; <https://developers.zoom.us/docs/meeting-sdk/web/component-view/meetings-webinars/> |
| **Nur authentifizierte Nutzer** („Only Authenticated Users Can Join") | `zak` | <https://github.com/zoom/zoom-plugin/blob/main/skills/meeting-sdk/references/bot-authentication.md> |
| **Meeting starten** statt beitreten | `role: 1` in der Signatur **und** `zak` des Hosts | <https://developers.zoom.us/docs/meeting-sdk/web/client-view/meetings-webinars/> |
| **Nur Warteraum** | kein zusätzliches Token; `passWord` als leerer String | Typdefinition: „Leave as an empty string if the meeting or webinar only requires the waiting room." |
| Webinar statt Meeting | `userEmail` | Typdefinition |

**Nicht belegt:** Dass der Warteraum allein irgendein zusätzliches Token verlangte, ließ sich in Zooms Dokumentation nirgends finden. Die einzige dokumentierte Wirkung des Warteraums auf die `join`-Parameter ist der leere `passWord`-String.

---

## Frage 4 — Secure Context, HTTPS, Cross-Origin-Isolation

### HTTPS

**Nicht belegt.** Eine ausdrückliche Aussage von Zoom, dass das Meeting SDK für Web über HTTPS ausgeliefert werden *muss*, ließ sich in der offiziellen Dokumentation nicht finden. Die Seiten „Zoom Meeting SDK for web" (<https://developers.zoom.us/docs/meeting-sdk/web/>), „Get started" (<https://developers.zoom.us/docs/meeting-sdk/web/get-started/>) und das README von <https://github.com/zoom/meetingsdk-web> enthalten keine solche Anforderung. Was dort als technische Voraussetzung genannt wird, ist lediglich `<meta charset="UTF-8" />` im Einstiegspunkt und, bei Einsatz von CSP-Headern, eine angepasste Content Security Policy.

Vorsicht bei einer häufigen Verwechslung: Die Aussage „Zoom Apps do not support localhost and must be served over https" betrifft **Zoom Apps** (die in den Zoom-Client eingebetteten Apps), **nicht** das Meeting SDK für Web. Diese beiden Produkte nicht vermengen.

### Gilt `http://localhost` als sicherer Kontext, und dokumentiert Zoom das?

**Ein ausdrücklich dokumentierter Satz von Zoom dazu: nicht belegt.** Es gibt aber zwei starke indirekte Belege aus Zooms eigenen Quellen, dass HTTP auf localhost im Entwicklungsbetrieb funktioniert:

1. **Zooms eigenes Beispielprojekt startet standardmäßig über HTTP.** Das README von <https://github.com/zoom/meetingsdk-web-sample> beschreibt `npm start` als HTTP auf Port 9999 und bietet `npm run https` mit mitgelieferten lokalen Zertifikaten nur als *Alternative* an. Zoom liefert also selbst einen HTTP-Entwicklungsmodus aus.
2. **Zoom-Mitarbeiter nennen `http://localhost:[PortNumber]` ausdrücklich als zulässigen Origin.** In der Anleitung von „gianni.zoom" zum SharedArrayBuffer-Origin-Trial heißt es, man solle für lokales Testen `http://localhost:[PortNumber]` als Origin eintragen. <https://devforum.zoom.us/t/updated-web-isolation-sharedarraybuffer-workflow-fix-for-web-meeting-sdk/55706>

Der eigentliche Grund liegt ohnehin nicht bei Zoom, sondern beim Browser: `http://localhost` und `http://127.0.0.1` gelten nach der W3C-Spezifikation „Secure Contexts" als *potentially trustworthy origins*. Das ist aber eine Browser-Eigenschaft, keine Zoom-Zusage — für diese Datei bleibt die Zoom-seitige Aussage daher: **nicht belegt.**

Ein Sonderfall für CueLight: CueLight setzt `isSupportAV: false` in `ZoomMtg.init`, braucht also weder Kamera noch Mikrofon. Damit entfällt der häufigste praktische Grund, aus dem ein unsicherer Kontext das SDK ausbremst (`getUserMedia` verlangt einen sicheren Kontext). **Nicht belegt** ist allerdings, ob Zoom irgendwo zusichert, dass das SDK ohne AV in einem unsicheren Kontext vollständig arbeitet.

### SharedArrayBuffer und Cross-Origin-Isolation

Zoom sagt hier ausdrücklich: **optional.**

> „SharedArrayBuffer (SAB) is a web API that is available in all major browsers that enables shared memory in JavaScript. … It's not required for the SDK to function and it's not required when using WebRTC."
> — <https://developers.zoom.us/docs/meeting-sdk/web/sharedarraybuffer/>

Wer SAB nutzen will, hat laut derselben Seite mehrere Wege:

| Weg | Header |
|---|---|
| Cross-Origin-Isolation | `Cross-Origin-Opener-Policy: same-origin` **und** `Cross-Origin-Embedder-Policy: require-corp` |
| Credentialless (verträglicher mit Fremdinhalten) | `Cross-Origin-Opener-Policy: same-origin` **und** `Cross-Origin-Embedder-Policy: credentialless` |
| Document-Isolation-Policy (nur Chrome/Edge ab 137) | `Document-Isolation-Policy: isolate-and-require-corp` oder `isolate-and-credentialless` |
| Service Worker bzw. Chrome Origin Trial | — |

Prüfen lässt sich das Ergebnis im Browser über `window.crossOriginIsolated`.

Für den Produktivbetrieb empfiehlt Zoom im eigenen Beispielprojekt für die Meeting-Seite zusätzlich `Cross-Origin-Resource-Policy: cross-origin` neben COEP und COOP. <https://github.com/zoom/meetingsdk-web-sample>

**Nicht belegt:** welche konkreten Meeting-SDK-Funktionen ohne SharedArrayBuffer wegfallen. Die Dokumentation spricht nur allgemein von „advanced features" und Leistungsgewinn bei WebAssembly und nennt keine Funktionsliste. Für CueLight — reine Anzeige gehobener Hände, kein eigenes Video, kein Audio — ist **nicht belegt**, dass SAB irgendeinen Nutzen hätte.

---

## Frage 5 — Dokumentierte Mindestkonfiguration für eine reine „Beitreten als Teilnehmer"-Anwendung

Eine als solche ausgewiesene „Mindestkonfiguration" gibt es bei Zoom **nicht** als eigene Seite. **Nicht belegt** ist damit eine offizielle Checkliste. Zusammensetzen lässt sie sich aber aus drei Zoom-Quellen, und alle drei stimmen überein:

**Aus <https://developers.zoom.us/docs/meeting-sdk/get-credentials/>:**

1. Zoom-Konto mit Rolle „Account owner", „Admin" oder „Zoom for developers"; der Administrator muss unter den SDK-Einstellungen View- und Edit-Rechte freigeschaltet haben.
2. Eine **General App** im Zoom App Marketplace anlegen.
3. Unter **Features → Embed** den Schalter **Meeting SDK** einschalten.
4. Client ID und Client Secret von der Seite **Basic Information** übernehmen.
5. Scopes: nur nötig, soweit die App REST-APIs aufruft. Für ZAK ausdrücklich „View a user's zak token" (user-managed) bzw. „View all user information" (admin-managed). Für OBF laut Blog `user:read:token`.

**Aus <https://github.com/zoom/meetingsdk-auth-endpoint-sample>** (Zooms eigenes Referenz-Backend für die Signatur): Es braucht genau zwei Werte, `ZOOM_MEETING_SDK_KEY` und `ZOOM_MEETING_SDK_SECRET` (für Apps ab dem 11. Februar 2023: Client ID und Client Secret). **OAuth und Scopes kommen im README dieses Beispiels überhaupt nicht vor.** Das ist der deutlichste Beleg dafür, dass reines Beitreten ohne OAuth auskommt.

**Aus <https://github.com/zoom/meetingsdk-javascript-sample>** (Zooms Client-View-Beispiel): die zu setzenden Werte sind `authEndpoint`, `meetingNumber`, `passWord`, `role` (0 = Teilnehmer), `userName`, `userEmail`, `leaveUrl`. Kein OAuth, kein OBF, keine Redirect-URL.

### Die kürzeste belegbare Liste

Für „Beitreten als stummer Teilnehmer, Meeting im eigenen Konto":

- General App im Marketplace, Meeting SDK unter Features → Embed eingeschaltet
- Client ID + Client Secret
- ein Backend, das daraus die SDK-JWT-Signatur mit `role: 0` erzeugt
- **kein** OAuth, **keine** Redirect-URL, **keine** Scopes, **keine** App-Prüfung, **kein** `obfToken`

Alles darüber hinaus — OAuth-Fluss, Redirect-URL, Scopes, Freigabe durch den Host, App-Review — wird ausschließlich dadurch ausgelöst, dass das Meeting einem **fremden** Konto gehört.

---

## Was daraus für CueLight folgt

CueLight ruft heute `ZoomMtg.join({ signature, meetingNumber, passWord, userName, obfToken })` auf. Der Kommentar im Quelltext (`public/index.html`, um Zeile 3204) beschreibt die Lage bereits zutreffend: „Läuft es im eigenen Konto, genügt die Signatur allein." Diese Recherche bestätigt das aus Zooms eigenen Quellen.

Konkret:

1. **Wenn die Meeting-SDK-App in demselben Zoom-Konto angelegt wird, aus dem die Meetings gestartet werden**, kann der gesamte OAuth-Teil der Einrichtung entfallen: kein Redirect-URL-Eintrag, keine Scopes, keine Freigabe durch den Host, kein `/api/obf-token`. `obfToken` wird dann schlicht nicht übergeben. Beleg: <https://developers.zoom.us/docs/meeting-sdk/obf-faq/> (Zeile „Join within app owner's account → JWT only") und <https://developers.zoom.us/changelog/meeting-sdk/requiring-authorization-for-meetings-joined-outside-of-an-apps-account/> („no change is needed").
2. **Wenn das Meeting einem fremden Konto gehört**, ist OAuth nicht das eigentliche Hindernis, sondern nur die halbe Miete: Zoom verlangt zusätzlich eine bestandene App-Prüfung. Eine unveröffentlichte App kommt laut Zoom-Mitarbeitern gar nicht hinein. Wer diesen Fall abdecken will, muss die Vorlaufzeit einkalkulieren („at least a month before your deadline").
3. **Nebenbefund, zeitkritisch:** Zoom setzt die Migration von SDK Key/Secret auf Client ID/Client Secret **ab dem 27. Juni 2026** durch; der Parameter `sdkKey` in `join` ist bereits `@deprecated` und „will cause errors in future versions". Dieses Datum liegt zum Recherchezeitpunkt in der Vergangenheit. Die Signatur muss ohnehin ein `appKey`-Feld enthalten (`appKey:clientId`), sonst „can't join meeting". <https://developers.zoom.us/docs/meeting-sdk/sdk-key-migration/>
4. **Nebenbefund zum heutigen Verhalten:** Der bestehende Code versucht das OBF-Token und macht bei Fehlschlag mit der Signatur allein weiter. Das ist nach dieser Recherche genau richtig herum gebaut — im eigenen Konto funktioniert der Fallback, im fremden Konto meldet Zoom den Attributionsfehler selbst.

---

## Ausdrücklich nicht belegt

Damit hier keine Vermutung als Befund durchgeht — Folgendes ließ sich in den zugelassenen Primärquellen **nicht** finden:

- Eine Aussage von Zoom, dass das Meeting SDK für Web zwingend über HTTPS ausgeliefert werden muss.
- Eine ausdrückliche Zoom-Aussage, dass `http://localhost` bzw. `http://127.0.0.1` als sicherer Kontext gilt und das SDK dort vollständig funktioniert. (Zooms eigenes Beispiel läuft per Voreinstellung über HTTP auf localhost, und ein Zoom-Mitarbeiter nennt `http://localhost:[Port]` als zulässigen Origin — das ist Indiz, keine Zusage.)
- Eine Liste der Meeting-SDK-Funktionen, die ohne SharedArrayBuffer wegfallen.
- Eine als solche bezeichnete offizielle „Mindestkonfiguration" für eine reine Teilnehmer-App.
- Eine inhaltliche Beschreibung von `obfToken` und `childToken` in der Parameterreferenz selbst (dort steht nur „Optional. obfToken." bzw. „Optional. childToken.").
- Was genau mit nicht migrierten Apps nach dem 27. Juni 2026 geschieht (die Migrationsseite nennt das Datum, aber keinen Durchsetzungsmechanismus).
- Ob der Warteraum allein ein zusätzliches Token (`zak`, `tk` oder OBF) erfordert.

---

## Quellenverzeichnis

**Zoom Developer Docs**

- Meeting SDK Übersicht — <https://developers.zoom.us/docs/meeting-sdk/>
- Meeting SDK authorization — <https://developers.zoom.us/docs/meeting-sdk/auth/>
- FAQ – Updates to Meeting SDK authorization — <https://developers.zoom.us/docs/meeting-sdk/obf-faq/>
- Get credentials — <https://developers.zoom.us/docs/meeting-sdk/get-credentials/>
- SDK Key migration — <https://developers.zoom.us/docs/meeting-sdk/sdk-key-migration/>
- Meeting SDK for web — <https://developers.zoom.us/docs/meeting-sdk/web/>
- Get started (web) — <https://developers.zoom.us/docs/meeting-sdk/web/get-started/>
- Client View – Meetings and webinars — <https://developers.zoom.us/docs/meeting-sdk/web/client-view/meetings-webinars/>
- Component View – Meetings and webinars — <https://developers.zoom.us/docs/meeting-sdk/web/component-view/meetings-webinars/>
- SharedArrayBuffer — <https://developers.zoom.us/docs/meeting-sdk/web/sharedarraybuffer/>
- Meeting SDK feature review & requirements — <https://developers.zoom.us/docs/distribute/sdk-feature-review-requirements/>
- Sharing Private and Beta Apps — <https://developers.zoom.us/docs/distribute/sharing-private-and-beta-apps/>

**Zoom Changelog und Zoom Developer Blog**

- Requiring authorization for meetings joined outside of an app's account — <https://developers.zoom.us/changelog/meeting-sdk/requiring-authorization-for-meetings-joined-outside-of-an-apps-account/>
- Meeting SDK apps now require review to join meetings outside their own account — <https://developers.zoom.us/changelog/platform/meeting-sdk-policy-announcement/>
- Transitioning to On Behalf Of (OBF) tokens in Meeting SDK apps — <https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/>

**Zooms eigene Repositories und Auslieferung**

- API-Referenz `ZoomMtg.join` — <https://marketplacefront.zoom.us/sdk/meeting/web/functions/ZoomMtg.join.html>
- Typdefinitionen `@zoom/meetingsdk@6.2.0` — <https://cdn.jsdelivr.net/npm/@zoom/meetingsdk@6.2.0/index.d.ts>
- zoom/meetingsdk-web — <https://github.com/zoom/meetingsdk-web>
- zoom/meetingsdk-web-sample — <https://github.com/zoom/meetingsdk-web-sample>
- zoom/meetingsdk-javascript-sample — <https://github.com/zoom/meetingsdk-javascript-sample>
- zoom/meetingsdk-auth-endpoint-sample — <https://github.com/zoom/meetingsdk-auth-endpoint-sample>
- zoom/zoom-plugin, Bot-Authentifizierung — <https://github.com/zoom/zoom-plugin/blob/main/skills/meeting-sdk/references/bot-authentication.md>

**Zoom Developer Forum (nur Beiträge mit Zoom-Mitarbeitern)**

- Unpublished Zoom SDK App to join public meetings (Antworten von Donte und Chun Siong, Zoom) — <https://devforum.zoom.us/t/unpublished-zoom-sdk-app-to-join-public-meetings/95899>
- Updated Web Isolation / SharedArrayBuffer Workflow Fix for Web Meeting SDK (gianni.zoom) — <https://devforum.zoom.us/t/updated-web-isolation-sharedarraybuffer-workflow-fix-for-web-meeting-sdk/55706>
