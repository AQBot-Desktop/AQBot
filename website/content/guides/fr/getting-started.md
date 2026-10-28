# Démarrage rapide

## Installation

Téléchargez le dernier installateur depuis la [page de téléchargement](/fr/download) ou [GitHub Releases](https://github.com/AQBot-Desktop/AQBot/releases).

### macOS

| Puce | Fichier |
|------|---------|
| Apple Silicon (M1 / M2 / M3 / M4) | `AQBot_x.x.x_aarch64.dmg` |
| Intel | `AQBot_x.x.x_x64.dmg` |

1. Ouvrez le `.dmg` et faites glisser **AQBot** dans le dossier **Applications**.
2. Lancez AQBot. Si macOS bloque l'application, allez dans **Réglages Système → Confidentialité et sécurité** et cliquez sur **Ouvrir quand même**.

::: warning macOS : "L'app est endommagée" ou "Impossible de vérifier le développeur"
AQBot est signé avec le propre certificat de signature de code du projet, et non avec un certificat Apple Developer ID. Après un téléchargement depuis un navigateur, macOS peut donc encore indiquer que « AQBot est endommagé et ne peut pas être ouvert » ou que « AQBot ne peut pas être ouvert car le développeur ne peut pas être vérifié ».

Inutile de désactiver Gatekeeper pour tout le système — autorisez uniquement AQBot :

1. Dans le Finder, faites un Contrôle-clic sur `AQBot.app`, choisissez **Ouvrir**, puis cliquez à nouveau sur **Ouvrir**.
2. Si l'app est toujours bloquée, allez dans **Réglages Système → Confidentialité et sécurité**, repérez AQBot dans la section **Sécurité** et cliquez sur **Ouvrir quand même**.
3. Relancez AQBot.

L'autorisation Gatekeeper et l'autorisation d'Accessibilité sont deux réglages distincts. Pour utiliser la barre d'outils de sélection de texte, activez aussi AQBot dans **Réglages Système → Confidentialité et sécurité → Accessibilité** lorsque l'app vous y invite.
:::

### Windows

| Architecture | Fichier |
|-------------|---------|
| x64 (la plupart des PC) | `AQBot_x.x.x_x64-setup.exe` |
| ARM64 | `AQBot_x.x.x_arm64-setup.exe` |

Exécutez l'installateur et suivez l'assistant. Lancez AQBot depuis le menu Démarrer ou le raccourci bureau.

### Linux

| Format | Architecture | Fichier |
|--------|-------------|---------|
| Debian / Ubuntu | x64 | `AQBot_x.x.x_amd64.deb` |
| Debian / Ubuntu | ARM64 | `AQBot_x.x.x_arm64.deb` |
| Fedora / openSUSE | x64 | `AQBot_x.x.x_x86_64.rpm` |
| Fedora / openSUSE | ARM64 | `AQBot_x.x.x_aarch64.rpm` |
| Toute distro | x64 | `AQBot_x.x.x_amd64.AppImage` |
| Toute distro | ARM64 | `AQBot_x.x.x_aarch64.AppImage` |

```bash
# Debian / Ubuntu
sudo dpkg -i AQBot_x.x.x_amd64.deb

# Fedora / openSUSE
sudo rpm -i AQBot_x.x.x_x86_64.rpm

# AppImage (toute distro)
chmod +x AQBot_x.x.x_amd64.AppImage
./AQBot_x.x.x_amd64.AppImage
```

---

## Configuration initiale

### 1. Ouvrir les paramètres

Lancez AQBot et cliquez sur l'**icône d'engrenage** en bas de la barre latérale, ou appuyez sur <kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd>.

### 2. Ajouter un fournisseur

Naviguez vers **Paramètres → Fournisseurs** et cliquez sur le bouton **+**.

1. Entrez un nom d'affichage (ex. *OpenAI*).
2. Sélectionnez le type de fournisseur (OpenAI, Anthropic, Google Gemini, etc.).
3. Collez votre clé API.
4. Confirmez l'**URL de base** — l'endpoint officiel est pré-rempli pour les types intégrés.

::: tip
Vous pouvez ajouter autant de fournisseurs que vous le souhaitez. Chaque fournisseur gère son propre ensemble de clés API et de modèles indépendamment.
:::

### 3. Récupérer les modèles

Cliquez sur **Récupérer les modèles** pour obtenir la liste des modèles disponibles depuis l'API du fournisseur. Vous pouvez également ajouter des IDs de modèles manuellement si nécessaire.

### 4. Définir un modèle par défaut

Allez dans **Paramètres → Modèle par défaut** et choisissez le fournisseur et le modèle que les nouvelles conversations devront utiliser par défaut.

---

## Votre première conversation

1. Cliquez sur **Nouveau chat** dans la barre latérale (ou appuyez sur <kbd>Cmd/Ctrl</kbd>+<kbd>N</kbd>).
2. Sélectionnez un modèle depuis le sélecteur de modèles en haut du chat.
3. Tapez un message et appuyez sur <kbd>Entrée</kbd>.
4. AQBot diffuse la réponse en temps réel. Les modèles qui supportent les blocs de réflexion (ex. Claude, DeepSeek R1) affichent le processus de raisonnement dans une section repliable.

---

## Raccourcis

Voici les raccourcis clavier par défaut. Tous les raccourcis peuvent être personnalisés dans **Paramètres → Raccourcis**.

| Raccourci | Action |
|-----------|--------|
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> | Afficher / masquer la fenêtre actuelle |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> | Afficher / masquer toutes les fenêtres |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | Fermer la fenêtre |
| <kbd>Cmd/Ctrl</kbd>+<kbd>N</kbd> | Nouvelle conversation |
| <kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd> | Ouvrir les paramètres |
| <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> | Palette de commandes |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Basculer la passerelle API |

---

## Données et sauvegarde

### Répertoires de données

AQBot stocke les données dans deux emplacements :

| Chemin | Contenu |
|--------|---------|
| `~/.aqbot/` | État de l'application — base de données, clés de chiffrement, base vectorielle, certificats SSL |
| `~/Documents/aqbot/` | Fichiers utilisateur — images, documents, sauvegardes |

### Sauvegarde automatique

Allez dans **Paramètres → Sauvegarde** pour configurer les sauvegardes automatiques vers un répertoire local ou un serveur WebDAV.

---

## Prochaines étapes

- [Configurer les fournisseurs](./providers) — ajouter et gérer les fournisseurs IA
- [Serveurs MCP](./mcp) — connecter des outils externes pour étendre les capacités IA
- [Passerelle API](./gateway) — exposer vos fournisseurs comme serveur API local
