[简体中文](./README.md) | [繁體中文](./README-ZH-TW.md) | [English](./README-EN.md) | [日本語](./README-JA.md) | [한국어](./README-KO.md) | **Français** | [Deutsch](./README-DE.md) | [Español](./README-ES.md) | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## Captures d'écran

| Rendu des graphiques de chat | Fournisseurs et modèles |
|:---:|:---:|
| ![](.github/images/s1.png) | ![](.github/images/s2.png) |

| Base de connaissances | Mémoire |
|:---:|:---:|
| ![](.github/images/s3.png) | ![](.github/images/s4.png) |

| Agent - Demande | Passerelle API en un clic |
|:---:|:---:|
| ![](.github/images/s5.png) | ![](.github/images/s6.png) |

| Sélection du modèle de chat | Navigation des chats |
|:---:|:---:|
| ![](.github/images/s7.png) | ![](.github/images/s8.png) |

| Agent - Approbation des permissions | Aperçu de la passerelle API |
|:---:|:---:|
| ![](.github/images/s9.png) | ![](.github/images/s10.png) |

## Fonctionnalités

### Chat et modèles

- **Support multi-fournisseurs** — Compatible avec OpenAI, Anthropic Claude, Google Gemini et toutes les API compatibles OpenAI
- **Gestion des modèles** — Récupération des listes de modèles distants, personnalisation des paramètres (température, tokens max, Top-P, etc.)
- **Rotation multi-clés** — Configurez plusieurs clés API par fournisseur avec rotation automatique pour distribuer la pression des limites de débit
- **Sortie en streaming** — Rendu en temps réel token par token avec blocs de réflexion repliables
- **Versions de messages** — Basculez entre plusieurs versions de réponse par message pour comparer les effets des modèles ou des paramètres
- **Ramification de conversation** — Créez de nouvelles branches à partir de n'importe quel nœud de message, avec comparaison côte à côte des branches
- **Gestion des conversations** — Épinglage, archivage, affichage groupé par temps et opérations en masse
- **Compression de conversation** — Compresse automatiquement les longues conversations en préservant les informations clés pour économiser l'espace de contexte
- **Réponse simultanée multi-modèles** — Posez la même question à plusieurs modèles simultanément avec comparaison côte à côte des réponses

### AI Agent

- **Mode Agent** — Passez en mode Agent pour l'exécution autonome de tâches multi-étapes : lecture/écriture de fichiers, exécution de commandes, analyse de code, et plus
- **Trois niveaux de permissions** — Par défaut (écritures nécessitent approbation), Accepter les modifications (approbation automatique des modifications de fichiers), Accès complet (sans invite) — sûr et contrôlable
- **Sandbox de répertoire de travail** — Les opérations de l'Agent sont strictement confinées au répertoire de travail spécifié, empêchant tout accès non autorisé
- **Panneau d'approbation des outils** — Affichage en temps réel des demandes d'appel d'outils avec examen individuel, « toujours autoriser » en un clic, ou refuser
- **Suivi des coûts** — Statistiques d'utilisation des tokens et des coûts en temps réel par session

### Rendu de contenu

- **Rendu Markdown** — Prise en charge complète de la coloration syntaxique du code, des formules mathématiques LaTeX, des tableaux et des listes de tâches
- **Éditeur de code Monaco** — Monaco Editor intégré dans les blocs de code avec coloration syntaxique, copie et aperçu diff
- **Rendu de diagrammes** — Rendu intégré des diagrammes de flux Mermaid et des diagrammes d'architecture D2
- **Panneau Artifact** — Extraits de code, brouillons HTML, notes Markdown et rapports consultables dans un panneau dédié
- **Chat vocal en temps réel** — (Prochainement) Voix en temps réel basée sur WebRTC avec support de l'API OpenAI Realtime

### Recherche et connaissances

- **Recherche Web** — Intégré avec Tavily, Zhipu WebSearch, Bocha et plus, avec annotations de sources de citation
- **Base de connaissances locale (RAG)** — Prend en charge plusieurs bases de connaissances ; téléchargez des documents pour une analyse, un découpage et une indexation automatiques, avec récupération sémantique des passages pertinents pendant les conversations
- **Système de mémoire** — Prend en charge la mémoire de conversation multi-espace de noms, avec saisie manuelle ou extraction automatique par IA (extraction automatique prochainement)
- **Gestion du contexte** — Attachez de manière flexible des pièces jointes, des résultats de recherche, des passages de base de connaissances, des entrées de mémoire et des sorties d'outils

### Outils et extensions

- **Protocole MCP** — Implémentation complète du Model Context Protocol supportant les transports stdio et HTTP
- **Outils intégrés** — Outils MCP intégrés prêts à l'emploi comme `@aqbot/fetch`
- **Panneau d'exécution des outils** — Affichage visuel des requêtes d'appel d'outils et des résultats retournés

### Passerelle API

- **Passerelle API locale** — Serveur API local intégré avec prise en charge native des interfaces OpenAI-compatible, Claude et Gemini, utilisable comme backend pour tout client compatible
- **Gestion des clés API** — Générez, révoquez et activez/désactivez les clés d'accès avec des notes descriptives
- **Analyses d'utilisation** — Analyse du volume de requêtes et de l'utilisation des tokens par clé, fournisseur et date
- **Support SSL/TLS** — Génération intégrée de certificats auto-signés, avec prise en charge des certificats personnalisés
- **Journaux des requêtes** — Enregistrement complet de toutes les requêtes et réponses API passant par la passerelle
- **Modèles de configuration** — Modèles d'intégration pré-construits pour les outils CLI populaires tels que Claude, Codex, OpenCode et Gemini

### Données et sécurité

- **Chiffrement AES-256** — Les clés API et les données sensibles sont chiffrées localement avec AES-256 ; clé maître stockée avec des permissions 0600
- **Répertoires de données isolés** — État de l'application dans `~/.aqbot/` ; fichiers utilisateur dans `~/Documents/aqbot/`
- **Sauvegarde automatique** — Sauvegardes automatiques planifiées vers des répertoires locaux ou un stockage WebDAV
- **Restauration de sauvegarde** — Restauration en un clic à partir des sauvegardes historiques
- **Export de conversation** — Exportez les conversations en captures PNG, Markdown, texte brut ou JSON

### Expérience bureau

- **Changement de thème** — Thèmes sombre/clair qui suivent les préférences du système ou peuvent être définis manuellement
- **Langue d'interface** — Prise en charge complète du chinois simplifié, du chinois traditionnel, de l'anglais, du japonais, du coréen, du français, de l'allemand, de l'espagnol, du russe, de l'hindi et de l'arabe, commutable à tout moment dans les paramètres
- **Barre d'état système** — Réduction dans la barre d'état système à la fermeture de la fenêtre sans interrompre les services en arrière-plan
- **Toujours au premier plan** — Épinglez la fenêtre principale pour qu'elle reste au-dessus de toutes les autres fenêtres
- **Raccourcis globaux** — Raccourcis clavier globaux personnalisables pour appeler la fenêtre principale à tout moment
- **Démarrage automatique** — Lancement optionnel au démarrage du système
- **Support proxy** — Configuration de proxy HTTP et SOCKS5
- **Mise à jour automatique** — Vérifie automatiquement les nouvelles versions au démarrage et invite à la mise à jour

## Plateformes prises en charge

| Plateforme | Architecture |
|------------|-------------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## Démarrage rapide

Rendez-vous sur la page [Releases](https://github.com/AQBot-Desktop/AQBot/releases) et téléchargez le programme d'installation pour votre plateforme.

## FAQ

### macOS : « L'application est endommagée » ou « Impossible de vérifier le développeur »

Comme l'application n'est pas signée par Apple, macOS peut afficher l'une des invites suivantes :

- « AQBot » est endommagé et ne peut pas être ouvert
- « AQBot » ne peut pas être ouvert car Apple ne peut pas vérifier l'absence de logiciels malveillants

**Étapes pour résoudre le problème :**

**1. Autoriser les applications de « N'importe où »**

```bash
sudo spctl --master-disable
```

Ensuite, allez dans **Réglages Système → Confidentialité et sécurité → Sécurité** et sélectionnez **N'importe où**.

**2. Supprimer l'attribut de quarantaine**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> Astuce : Vous pouvez faire glisser l'icône de l'application dans le terminal après avoir tapé `sudo xattr -dr com.apple.quarantine `.

**3. Étape supplémentaire pour macOS Ventura et versions ultérieures**

Après avoir effectué les étapes ci-dessus, le premier lancement peut encore être bloqué. Allez dans **Réglages Système → Confidentialité et sécurité**, puis cliquez sur **Ouvrir quand même** dans la section Sécurité. Cette opération n'est nécessaire qu'une seule fois.

## Communauté
- [LinuxDO](https://linux.do)

## Licence

Ce projet est sous licence [AGPL-3.0](LICENSE).
