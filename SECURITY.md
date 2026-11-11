# Politique de sécurité

## Versions prises en charge

Seule la dernière version mineure publiée reçoit les correctifs de sécurité.

## Signaler un problème

Vous avez trouvé un bug ou une faille ? Ouvrez une [issue](https://github.com/AristideDongo/smpp-ts/issues) ou proposez directement un correctif en [pull request](https://github.com/AristideDongo/smpp-ts/pulls).

Pour qu'on puisse le traiter rapidement, indiquez :

- la version concernée (`npm ls smpp-ts`) et la version de Node ;
- une description du problème et de son impact ;
- un moyen de le reproduire : PDU en hexadécimal, script minimal… ;
- si possible, une piste de correction.

**Ne publiez jamais d'identifiants réels** (system_id, mot de passe, adresse d'un SMSC de production) ni de numéros de téléphone de vrais abonnés dans une issue ou une PR. Masquez-les avant de partager des logs ou des captures de PDU.

Le crédit de la découverte vous revient dans le CHANGELOG, sauf si vous préférez rester anonyme.

## Garanties de conception

- Vérification TLS activée par défaut, TLS 1.2 minimum.
- Mots de passe jamais journalisés, ni dans les logs, ni dans les événements, ni dans les messages d'erreur.
- Chaque champ est validé contre la spécification, à l'envoi comme à la réception.
- Le parseur, testé par fuzzing, ne lève que des erreurs typées.
- Ressources bornées : taille des PDU, fenêtre d'envoi, file, buffers de réassemblage, sessions.
- Aucune dépendance runtime.
