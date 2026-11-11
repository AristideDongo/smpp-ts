# Tests d'interopérabilité

Ces tests vérifient `smpp-ts` contre un SMSC **qui n'est pas** le serveur de la lib : bind, `enquire_link`, envoi GSM7 et UCS2, messages longs (`udh8`, `udh16`, `sar`), fenêtre d'envoi et accusés de réception.

Ils ne font pas partie de `npm test` : sans `SMPP_INTEROP_URL`, ils sont ignorés.

## Contre le simulateur Docker

```sh
docker compose -f test/interop/docker-compose.yml up -d --build
SMPP_INTEROP_URL=smpp://127.0.0.1:2775 npm run test:interop
docker compose -f test/interop/docker-compose.yml down
```

## Contre le SMSC de test de votre opérateur

La plupart des opérateurs fournissent un compte de test. Lancez la même suite contre lui avant la mise en production :

```sh
SMPP_INTEROP_URL=ssmpp://smsc-test.operateur.example:3550 \
SMPP_INTEROP_SYSTEM_ID=mon_compte \
SMPP_INTEROP_PASSWORD=... \
SMPP_INTEROP_FROM=MONSERVICE \
SMPP_INTEROP_TO=+2250700000000 \
npm run test:interop
```

⚠️ Contre un vrai SMSC, des SMS sont réellement envoyés au numéro `SMPP_INTEROP_TO` (une trentaine par exécution). Utilisez un numéro de test qui vous appartient.

| Variable | Défaut | Rôle |
|---|---|---|
| `SMPP_INTEROP_URL` | — (tests ignorés) | `smpp://hôte:port` ou `ssmpp://hôte:port` |
| `SMPP_INTEROP_SYSTEM_ID` | `smppts` | Identifiant de bind |
| `SMPP_INTEROP_PASSWORD` | `secret` | Mot de passe de bind |
| `SMPP_INTEROP_SYSTEM_TYPE` | — | `system_type`, si l'opérateur l'exige |
| `SMPP_INTEROP_FROM` | `SMPPTS` | Expéditeur (alphanumérique ou numéro) |
| `SMPP_INTEROP_TO` | `+2250700000000` | Destinataire |
| `SMPP_INTEROP_EXPECT_DLR` | `1` | `0` si le SMSC n'envoie pas d'accusés |
| `SMPP_INTEROP_DLR_TIMEOUT` | `30000` | Attente maximale des accusés (ms) |
| `SMPP_INTEROP_TLS_CA` | — | Chemin du certificat d'autorité d'un SMSC à certificat auto-signé |

Si un test échoue contre votre opérateur, ouvrez une issue avec la sortie du test (sans identifiants) : c'est exactement le type de variante que la lib doit absorber.
