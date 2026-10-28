# API गेटवे

## API गेटवे क्या है?

AQBot में एक बिल्ट-इन लोकल API सर्वर है जो आपके कॉन्फ़िगर किए गए प्रदाताओं को **OpenAI-कम्पैटिबल**, **Claude-नेटिव** और **Gemini-नेटिव** एंडपॉइंट के रूप में एक्सपोज़ करता है। इन प्रोटोकॉल में से किसी का भी उपयोग करने वाला कोई भी टूल या क्लाइंट AQBot को बैकएंड के रूप में उपयोग कर सकता है।

उपयोग केस:

- AQBot के माध्यम से **Claude Code CLI**, **OpenAI Codex CLI**, **Gemini CLI**, या **OpenCode** चलाएं।
- अपने IDE एक्सटेंशन को एकल, लोकल रूप से प्रबंधित एंडपॉइंट से फीड करें।
- प्रति-की रेट लिमिटिंग के साथ कई टूल्स में प्रदाता कीज़ का एक सेट साझा करें।

---

## शुरुआत

1. **Settings → API Gateway** खोलें (या <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> दबाएं)।
2. गेटवे सर्वर लॉन्च करने के लिए **Start** क्लिक करें।
3. डिफ़ॉल्ट रूप से सर्वर `127.0.0.1:8080` (HTTP) पर सुनता है।

::: tip
AQBot शुरू होने पर सर्वर ऑटोमैटिकली लॉन्च हो, इसके लिए गेटवे Settings में **Auto-start** एनेबल करें।
:::

---

## API की मैनेजमेंट

1. **API Keys** टैब में जाएं।
2. **Generate New Key** क्लिक करें।
3. वैकल्पिक रूप से हर की की पहचान के लिए **description** जोड़ें।
4. की कॉपी करें — यह केवल एक बार दिखाई देती है।

---

## कॉन्फ़िगरेशन टेम्पलेट

### Claude Code CLI

```bash
claude config set --global apiUrl http://127.0.0.1:8080
claude config set --global apiKey aqbot-xxxx
```

### OpenAI Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=aqbot-xxxx
codex
```

### Gemini CLI

```bash
export GEMINI_API_BASE=http://127.0.0.1:8080
export GEMINI_API_KEY=aqbot-xxxx
gemini
```

### कस्टम क्लाइंट

```
Base URL:  http://127.0.0.1:8080/v1
API Key:   aqbot-xxxx
```

---

## अगले कदम

- [त्वरित प्रारंभ](./getting-started) — क्विक स्टार्ट गाइड पर वापस जाएं
- [प्रदाता कॉन्फ़िगर करें](./providers) — गेटवे जिन अपस्ट्रीम प्रदाताओं को रूट करता है, उन्हें जोड़ें
- [MCP सर्वर](./mcp) — AI टूल कॉलिंग के लिए बाहरी टूल्स कनेक्ट करें
