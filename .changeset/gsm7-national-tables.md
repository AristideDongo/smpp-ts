---
"smpp-ts": minor
---

GSM7: every national language table of 3GPP TS 23.038 (Release 9+).

- 13 single shift tables (UDH IE 0x24): Turkish, Spanish, Portuguese, Bengali, Gujarati, Hindi, Kannada, Malayalam, Oriya, Punjabi, Tamil, Telugu, Urdu.
- 12 locking shift tables (UDH IE 0x25, all but Spanish): 1 septet per national character. A Hindi text goes in 152 characters per SMS instead of 70 in UCS2.
- Detection (`shiftTables`) tries the single shift table alone, then locking + single. `shift` / `locking` force them. Incoming messages announcing a locking table are decoded.
- New exports: `NATIONAL_LANGUAGES`, `NATIONAL_LANGUAGE_ID`, `hasLockingShift`, types `Gsm7Tables` / `Gsm7Shift`. `encodeGsm7` / `decodeGsm7` / `canEncodeGsm7` accept `{ single, locking }`; a plain language code keeps meaning the single shift table.
