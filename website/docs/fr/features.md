# Fonctionnalités

AQBot est un assistant IA de bureau complet qui combine le chat multi-fournisseur, le rendu de contenu puissant, l'intégration d'outils et une passerelle API intégrée — tout fonctionne localement avec une sécurité des données robuste.

## Chat et modèles

Connectez-vous aux principaux fournisseurs d'IA depuis une interface unique et unifiée.

- **Support multi-fournisseurs** — Compatible avec OpenAI, Anthropic Claude, Google Gemini et toutes les API compatibles OpenAI. Chaque fournisseur est configuré indépendamment.
- **Gestion des modèles** — Récupération automatique des listes de modèles distants et personnalisation des paramètres de génération par conversation.
- **Rotation de clés multiples** — Configurez plusieurs clés API par fournisseur avec rotation automatique pour distribuer la pression des limites de débit.
- **Sortie en streaming** — Rendu en temps réel token par token. Blocs de réflexion repliables pour inspecter le raisonnement du modèle.
- **Versions de messages** — Chaque réponse peut avoir plusieurs versions. Comparez les effets de différents modèles ou paramètres côte à côte.
- **Branchement de conversation** — Créez une nouvelle branche à partir de n'importe quel nœud de message. Vue de comparaison de branches côte à côte.
- **Gestion des conversations** — Épinglez les conversations importantes, archivez les anciennes, parcourez un historique groupé par temps.
- **Compression de conversation** — Compressez automatiquement les longues conversations en préservant les informations clés.
- **Réponse simultanée multi-modèles** — Posez la même question à plusieurs modèles à la fois avec comparaison côte à côte.

## Rendu de contenu

AQBot va bien au-delà du chat en texte brut avec un pipeline de rendu riche et interactif.

- **Rendu Markdown** — Support complet des blocs de code avec coloration syntaxique, formules LaTeX, tableaux et listes de tâches.
- **Éditeur de code Monaco** — Les blocs de code intègrent Monaco (le moteur de VS Code) avec coloration syntaxique, copie en un clic et aperçu diff en ligne.
- **Rendu de diagrammes** — Rendu intégré pour les organigrammes Mermaid et les diagrammes d'architecture D2.
- **Panneau Artifact** — Les extraits de code, brouillons HTML, notes Markdown et rapports peuvent être ouverts dans un panneau latéral dédié.
- **Chat vocal en temps réel** — (Prochainement) Conversations vocales WebRTC basées sur l'API OpenAI Realtime.

## Recherche et connaissances

Enrichissez vos conversations avec des données web en direct, des documents locaux et une mémoire persistante.

- **Recherche web** — Intégration avec Tavily, Zhipu WebSearch, Bocha et plus. Les résultats incluent des annotations de sources de citation.
- **Base de connaissances locale (RAG)** — Supporte plusieurs bases de connaissances. Téléchargez des documents pour l'analyse automatique, le chunking et l'indexation vectorielle (sqlite-vec).
- **Système de mémoire** — Supporte la mémoire conversationnelle multi-espace de noms. Les entrées peuvent être ajoutées manuellement ou extraites automatiquement par l'IA (prochainement).
- **Gestion du contexte** — Attachez des pièces jointes, résultats de recherche, passages de la base de connaissances et sorties d'outils à n'importe quel message.

::: tip Prochainement
L'extraction automatique de mémoire par IA est en développement actif et sera disponible dans une prochaine version.
:::

## Outils et extensions

Étendez les capacités du modèle avec des outils externes et une interface de commande puissante.

- **Protocole MCP** — Implémentation complète du [Model Context Protocol](https://modelcontextprotocol.io/) supportant les transports **stdio** et **HTTP**.
- **Outils intégrés** — Outils MCP intégrés prêts à l'emploi comme `@aqbot/fetch` — aucune configuration supplémentaire requise.
- **Panneau d'exécution d'outils** — Un panneau visuel affiche chaque requête d'appel d'outil et son résultat de retour.

## Passerelle API

AQBot inclut un serveur API local intégré qui transforme votre application de bureau en une puissante passerelle IA.

- **Passerelle API locale** — Exposez un serveur local avec support natif pour les interfaces compatibles OpenAI, Claude et Gemini.
- **Gestion des clés API** — Générez, révoquez et activez ou désactivez les clés d'accès.
- **Analytiques d'utilisation** — Analysez le volume de requêtes et l'utilisation des tokens par clé, fournisseur et date.
- **Support SSL/TLS** — Génération intégrée de certificat auto-signé avec support d'importation de certificats personnalisés.
- **Journaux de requêtes** — Enregistrement complet de chaque requête et réponse API passant par la passerelle.
- **Modèles de configuration** — Modèles d'intégration préconstruits pour Claude Code, Codex CLI, OpenCode et Gemini CLI.

::: tip Pourquoi une passerelle locale ?
La passerelle vous permet d'utiliser AQBot comme backend IA unifié pour tous vos outils. Pointez vos clients CLI, extensions IDE ou scripts personnalisés vers la passerelle locale et bénéficiez de la rotation des clés, du suivi de l'utilisation et du contrôle d'accès.
:::

## Données et sécurité

Vos données ne quittent jamais votre machine. AQBot est conçu avec une sécurité locale d'abord à chaque couche.

- **Chiffrement AES-256** — Les clés API et autres données sensibles sont chiffrées localement avec AES-256. La clé de chiffrement principale est stockée avec des permissions de fichier `0600`.
- **Répertoires de données isolés** — L'état de l'application réside dans `~/.aqbot/`. Les fichiers visibles par l'utilisateur sont stockés dans `~/Documents/aqbot/`.
- **Sauvegarde automatique** — Planifiez des sauvegardes automatiques vers des répertoires locaux ou un stockage WebDAV.
- **Restauration de sauvegarde** — Restauration en un clic à partir de n'importe quelle sauvegarde historique.
- **Export de conversation** — Exportez les conversations en PNG, Markdown, texte brut ou JSON structuré.

::: warning Protégez votre clé principale
Le fichier `~/.aqbot/master.key` est la racine de tout le chiffrement dans AQBot. Gardez-le en sécurité et incluez-le dans vos sauvegardes. Si cette clé est perdue, les données chiffrées ne peuvent pas être récupérées.
:::

## Expérience bureau

AQBot est construit comme une application de bureau native avec le raffinement et l'intégration attendus d'un outil quotidien.

- **Changement de thème** — Thèmes sombre et clair qui suivent la préférence du système ou peuvent être réglés manuellement.
- **Langue de l'interface** — Support complet du français, chinois simplifié et anglais, changeables à tout moment dans les paramètres.
- **Barre système** — Réduisez dans la barre système à la fermeture de la fenêtre. Les services en arrière-plan continuent sans interruption.
- **Toujours visible** — Épinglez la fenêtre principale au-dessus de toutes les autres fenêtres.
- **Raccourcis globaux** — Raccourcis clavier globaux personnalisables pour invoquer la fenêtre principale de n'importe où.
- **Démarrage automatique** — Lancez optionnellement AQBot au démarrage du système.
- **Support proxy** — Configurez des proxys HTTP et SOCKS5 pour les environnements à accès réseau restreint.
- **Mise à jour automatique** — AQBot vérifie automatiquement les nouvelles versions au démarrage.
