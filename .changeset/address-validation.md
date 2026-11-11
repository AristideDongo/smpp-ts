---
"smpp-ts": minor
---

`sendText` normalise et valide les adresses : retrait des séparateurs (`+225 07 00…`), préfixe `00` converti en TON international, expéditeur alphanumérique limité à 11 caractères GSM, numéro international limité à 15 chiffres. Option `address` pour ajuster ou désactiver. Les erreurs sont levées avant tout envoi (`SmppValidationError`).
