---
"smpp-ts": minor
---

Adaptateur OpenTelemetry `smpp-ts/otel` : `instrumentSmpp(clientOuServeur, meter)` relaie les métriques vers un `Meter` OpenTelemetry (compteurs, histogramme de latence, jauges, attribut `smpp.system_id` côté serveur). Aucune dépendance : le `Meter` est fourni par l'application.
