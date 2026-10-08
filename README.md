# pi-albert-status

Barre d'état pour [Pi](https://pi.dev) branché sur [Albert API](https://ia.numerique.gouv.fr/outils-ia/albert-api/) à travers [llm-proxy](https://codeberg.org/jbousquie/llm-proxy).

```
[gpt-oss-120b • medium] │ mon-projet (main)
Contexte ███░░░░░░░ 31% │ RPM ██░░░░░░░░ 12/50 │ TPM ████████░░ 200k/246k
Session 481k tok · ≈ 0.1 gCO2e │ Jour 167 req · 4.8 gCO2e │ ⏳ 1 en attente ~12s
```

![Barre d'état dans Pi](docs/barre.png)

## Ce qui est affiché

| Ligne | Élément | Signification | Source |
|---|---|---|---|
| 1 | `[gpt-oss-120b • …]` | modèle en cours | Pi |
| 1 | `• medium` | niveau de réflexion (*thinking*), réglé avec `/thinking`. Masqué pour un modèle déclaré sans réflexion (`"reasoning": false` dans `models.json`) | Pi |
| 1 | `mon-projet (main)` | dossier de travail et branche git | Pi |
| 2 | `Contexte … 31%` | taille de la dernière requête envoyée, rapportée à la fenêtre de contexte du modèle | estimation locale |
| 2 | `RPM … 12/50` | requêtes envoyées sur les 60 dernières secondes, rapportées au plafond `ALBERT_RPM` | comptage local |
| 2 | `TPM … 200k/246k` | jetons envoyés sur les 60 dernières secondes, rapportés au plafond `ALBERT_TPM` | estimation locale |
| 3 | `Session 481k tok` | jetons envoyés et reçus depuis le début de la session Pi | estimation locale |
| 3 | `≈ 0.1 gCO2e` | CO2 de la session : intensité du jour (g par jeton de sortie) × jetons de sortie de la session | calcul à partir de « Jour » |
| 3 | `Jour 167 req · 4.8 gCO2e` | requêtes et CO2 du jour (minuit UTC), pour la clé `ALBERT_KEY_ID` ou tout le compte | `GET /v1/me/usage` |
| 3 | `⏳ 1 en attente ~12s` | requêtes retenues par le régulateur de llm-proxy pour rester sous le quota, et attente prévue. N'apparaît que s'il y en a | `GET /proxy/attente` |
| 3 | `llm-proxy injoignable` | le proxy ne répond pas : « Jour » et ⏳ ne sont plus mis à jour | — |

Les jauges prennent les couleurs du thème de Pi, passent à l'orange à 70 % et au rouge à 90 %. La barre se rafraîchit toutes les 10 secondes, à chaque requête envoyée et à chaque fin de tour.

## Installation

Prérequis : Pi 1.0 ou plus, llm-proxy lancé (par défaut sur `http://127.0.0.1:8080`) et un provider Pi qui pointe dessus.

```bash
pi install git:github.com/benoitvx/pi-albert-status
```

Relancer Pi : la barre remplace le pied de page par défaut.

## Réglages

Variables d'environnement, toutes optionnelles :

| Variable | Rôle | Défaut |
|---|---|---|
| `LLM_PROXY_URL` | adresse de llm-proxy | `http://127.0.0.1:8080` |
| `ALBERT_KEY_ID` | identifiant de la clé Albert à suivre dans « Jour » | tout le compte |
| `ALBERT_RPM` | plafond de requêtes par minute affiché | `50` |
| `ALBERT_TPM` | plafond de jetons par minute affiché | `246000` |

Les plafonds par défaut sont ceux de la [grille publique d'Albert API](https://ia.numerique.gouv.fr/outils-ia/albert-api/tarifs-et-limites/) (paliers Expérimentation et Production limitée). Ils ne sont pas lus sur le compte : `/v1/me/info` donne les limites par routeur, sans correspondance avec les noms de modèles.

**Trouver l'identifiant de sa clé** : `/v1/me/keys` masque les jetons, on retrouve une clé par son usage. Après quelques appels, attendre une dizaine de minutes (Albert enregistre l'usage avec retard), puis :

```bash
end=$(date +%s); st=$((end - end % 86400)); B=https://albert.api.etalab.gouv.fr/v1
for i in $(curl -s -H "Authorization: Bearer $ALBERT_API_KEY" "$B/me/keys?limit=100" | jq -r '(.data // .)[].id'); do
  echo "$i $(curl -s -H "Authorization: Bearer $ALBERT_API_KEY" "$B/me/usage?start_time=$st&end_time=$end&key_id=$i" | jq -r '.data[0].requests // 0')"
done | sort -k2 -nr | head
```

## Limites connues

- **Jetons estimés** à 4 caractères par jeton, sur la requête entière. Via le proxy, l'usage renvoyé par Albert à Pi n'est pas exploitable. C'est un ordre de grandeur, pas le décompte d'Albert, qui compte plus large.
- **Débit compté par session Pi** : deux Pi ouverts en parallèle affichent chacun le leur, alors que le quota d'Albert s'applique au compte, modèle par modèle.
- **CO2 de session estimé** : intensité du jour (kg par jeton de sortie, selon Albert) multipliée par les jetons de sortie de la session.
- **« Jour » en retard** de 3 à 10 minutes, le temps qu'Albert enregistre l'usage.
- **⏳ seulement via le proxy** : rien ne s'affiche pour un provider qui appelle Albert en direct.

## Inspiration

Ce projet s'inspire dans son ensemble de [claude-hud](https://github.com/jarrodwatts/claude-hud), la barre d'état de Jarrod Watts pour Claude Code.

## Licence

MIT
