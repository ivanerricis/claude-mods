# claude-mods

Mod personali per Claude Code, raccolte in un unico marketplace (`ivan-mods`).

## Mod

| Mod | Cosa fa |
|---|---|
| `usage-limits` | Mostra sopra il prompt i limiti di utilizzo (5 ore e settimanale) con percentuale e orario di reset, il contesto usato, lo stato della Remote Control e gli agenti al lavoro. |

## Installazione

Al prompt di una sessione nel terminale:

```
/plugin install usage-limits --marketplace ivanerricis/claude-mods
```

Da una shell:

```
claude plugin install usage-limits --marketplace ivanerricis/claude-mods
```

Nell'app desktop, dove `/plugin` non funziona: clicca **+** accanto al campo del prompt, poi **Plugins**, **Add marketplace** con `ivanerricis/claude-mods`, poi **Add plugin**.

Alla domanda `Add marketplace?` rispondi `y`, poi scegli lo scope utente.

## Aggiornare

Dopo un push su questo repository, aggiorna il marketplace (`/plugin marketplace update ivan-mods`) e riavvia le sessioni.

Nota: la mod si vede solo nelle sessioni che girano sul PC dove è installata.
