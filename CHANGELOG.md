# smpp-ts

## 0.1.0

Première version publique.

- Client (`SmppClient`) et serveur (`SmppServer`) SMPP v3.4 / v5.0.
- Codec typé dérivé d'une table déclarative des commandes, TLV et codes de statut ; TLV personnalisés.
- Encodages GSM7 (tables de shift turque, espagnole, portugaise), Latin-1, UCS2 ; détection automatique.
- Messages longs (`udh8`, `udh16`, `sar`, `payload`) et réassemblage borné des messages entrants.
- Accusés de réception : parseur tolérant, priorité aux TLV, normalisation des statuts et des `message_id`.
- Fiabilité : machine à états, timeouts sur chaque opération, fenêtre d'envoi, file bornée, contrôle de débit adaptatif, keepalive avec détection de connexion morte, reconnexion avec re-bind, nouvelles tentatives sur erreurs temporaires, arrêt gracieux.
- Sécurité : TLS vérifié par défaut (TLS 1.2 minimum), secrets jamais journalisés, validation stricte, authentification serveur obligatoire, limites de ressources, Proxy Protocol v1/v2 avec proxys de confiance.
- Aucune dépendance runtime.
