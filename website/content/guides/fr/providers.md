# Configurer les fournisseurs

AQBot se connecte simultanément à n'importe quel nombre de fournisseurs IA. Chaque fournisseur a ses propres clés API, liste de modèles et paramètres par défaut.

## Fournisseurs supportés

| Fournisseur | Modèles exemple |
|------------|----------------|
| **OpenAI** | GPT-4o, GPT-4, o3, o4-mini |
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Alibaba Cloud** | Série Qwen |
| **Zhipu AI** | Série GLM |
| **xAI** | Série Grok |
| **API compatible OpenAI** | Ollama, vLLM, LiteLLM, relais tiers, etc. |

---

## Ajouter un fournisseur

1. Allez dans **Paramètres → Fournisseurs**.
2. Cliquez sur le bouton **+** en bas à gauche.
3. Remplissez les détails du fournisseur :

| Champ | Description |
|-------|-------------|
| **Nom** | Nom d'affichage pour la barre latérale (ex. *OpenAI*) |
| **Type** | Type de fournisseur — détermine l'URL de base par défaut |
| **Icône** | Icône optionnelle pour l'identification visuelle |
| **Clé API** | La clé secrète du tableau de bord de votre fournisseur |
| **URL de base** | Endpoint API (pré-rempli pour les types intégrés) |
| **Chemin API** | Chemin de requête — par défaut `/v1/chat/completions` |

---

## Importer depuis un lien Web

Les sites de fournisseurs, tableaux de bord de services relais, plateformes de modèles privées ou pages de passerelle locale peuvent proposer un lien **Ouvrir dans AQBot**. Lorsqu'un utilisateur clique dessus, le navigateur ouvre l'application de bureau AQBot, AQBot passe à **Paramètres → Fournisseurs**, affiche une boîte de confirmation et importe la configuration uniquement après confirmation.

### Parcours utilisateur

1. Installez et ouvrez une version d'AQBot compatible avec les liens de fournisseur.
2. Cliquez sur le lien **Ouvrir dans AQBot** fourni par le fournisseur dans le navigateur.
3. Vérifiez dans AQBot le nom du fournisseur, l'URL de base, le type de fournisseur et le préfixe de la clé API.
4. AQBot réutilise un fournisseur existant avec le même couple **URL de base + type**. S'il n'existe pas, AQBot en crée un nouveau et ajoute la clé API seulement si elle n'est pas déjà présente.

AQBot ne valide pas automatiquement la clé et ne récupère pas automatiquement les modèles. Après l'import, cliquez sur **Récupérer les modèles** ou ajoutez des modèles manuellement.

### Format du lien

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

Exemple :

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### Paramètres

| Paramètre | Obligatoire | Description |
|-----------|-------------|-------------|
| `name` | Oui | Nom affiché dans AQBot, par exemple `OpenAI` ou `My Relay` |
| `baseurl` | Oui | URL de base encodée. Seuls `http` et `https` sont acceptés ; query et hash sont refusés. |
| `apikey` | Oui | Clé API à enregistrer dans AQBot. AQBot n'affiche qu'un préfixe dans la boîte de confirmation. |
| `type` | Oui | Type de fournisseur. Valeurs autorisées : `openai`, `openai_responses`, `anthropic`, `gemini`, `custom`. |

`baseurl` peut utiliser le suffixe forcé existant d'AQBot, par exemple `https://example.com!`. L'import par lien ne définit pas `api_path` ; AQBot continue d'utiliser le chemin par défaut du type de fournisseur choisi.

### Configuration du site Web

Encodez toutes les valeurs dynamiques avec `encodeURIComponent` ou `URLSearchParams` :

```html
<a id="open-aqbot" href="#">Ouvrir dans AQBot</a>

<script>
  const provider = {
    name: 'My Relay',
    baseurl: 'https://api.example.com',
    apikey: 'sk-user-key',
    type: 'openai',
  };

  const params = new URLSearchParams({
    name: provider.name,
    baseurl: provider.baseurl,
    apikey: provider.apikey,
    type: provider.type,
  });

  document.getElementById('open-aqbot').href = `aqbot://providers?${params.toString()}`;
</script>
```

Si votre service permet de générer des clés API, créez le lien uniquement lorsque l'utilisateur est connecté et a explicitement choisi ou créé une clé.

::: warning Sécurité
Une clé API dans une URL peut être visible dans l'historique du navigateur, les journaux, les extensions ou les outils d'analyse. Ne placez pas de vraies clés sur des pages publiques, du HTML statique ou des redirections tierces. Préférez générer le lien sur une page privée du compte après confirmation de l'utilisateur.
:::

::: tip Test
`aqbot://` est un protocole personnalisé enregistré par l'application de bureau installée. Exécuter uniquement le site Web ou le serveur de développement Vite n'enregistre pas ce protocole. Si le lien n'ouvre pas AQBot, installez ou reconstruisez d'abord la dernière application de bureau AQBot.
:::

---

## Importer depuis CC Switch

AQBot peut scanner les configurations fournisseur de CC Switch depuis Settings -> Providers. Vérifiez chaque candidat, sélectionnez les lignes importables, puis importez fournisseurs, Base URLs, clés API et listes de modèles. Les entrées OAuth-only ou sans clé réutilisable sont ignorées avec une raison visible.

## Corps de requête modèle avancé

Chaque modèle peut définir extra_body, un objet JSON ajouté à plat aux requêtes OpenAI-compatible Chat Completions. Il sert aux options propres aux fournisseurs comme enable_thinking. AQBot valide le JSON et bloque l’écrasement de model, messages, stream, tools et des champs de sampling de base.

## Rotation de clés multiples

AQBot supporte plusieurs clés API par fournisseur pour la distribution de charge et l'évitement des limites de débit. Cliquez sur **Ajouter une clé** dans le panneau de détails du fournisseur.

---

## Gestion des modèles

Cliquez sur **Récupérer les modèles** pour obtenir la liste complète des modèles disponibles depuis l'API du fournisseur. Vous pouvez également ajouter des IDs de modèles manuellement.

Chaque modèle peut avoir ses propres paramètres par défaut : température, tokens maximum, Top P, pénalité de fréquence, pénalité de présence.

---

## Endpoints personnalisés et locaux

### Ollama (modèles locaux)

1. Installez et démarrez [Ollama](https://ollama.com/).
2. Dans AQBot, créez un nouveau fournisseur avec le type **OpenAI**.
3. Définissez l'**URL de base** à `http://localhost:11434`.
4. Cliquez sur **Récupérer les modèles** pour découvrir les modèles téléchargés localement.

---

## Prochaines étapes

- [Serveurs MCP](./mcp) — connecter des outils externes pour étendre les capacités IA
- [Passerelle API](./gateway) — exposer vos fournisseurs comme serveur API local
