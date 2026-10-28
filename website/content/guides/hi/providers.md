# प्रदाता कॉन्फ़िगर करें

AQBot एक साथ किसी भी संख्या में AI प्रदाताओं से कनेक्ट होता है। प्रत्येक प्रदाता की अपनी API कीज़, मॉडल लिस्ट और पैरामीटर डिफ़ॉल्ट होते हैं।

## समर्थित प्रदाता

| प्रदाता | उदाहरण मॉडल |
|---------|------------|
| **OpenAI** | GPT-4o, GPT-4, o3, o4-mini |
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Alibaba Cloud** | Qwen सीरीज़ |
| **Zhipu AI** | GLM सीरीज़ |
| **xAI** | Grok सीरीज़ |
| **OpenAI-कम्पैटिबल API** | Ollama, vLLM, LiteLLM, थर्ड-पार्टी रिले, आदि |

---

## प्रदाता जोड़ना

1. **Settings → Providers** में जाएं।
2. नीचे बाईं ओर **+** बटन क्लिक करें।
3. प्रदाता विवरण भरें:

| फ़ील्ड | विवरण |
|--------|-------|
| **नाम** | साइडबार के लिए डिस्प्ले नेम (जैसे *OpenAI*) |
| **प्रकार** | प्रदाता प्रकार — डिफ़ॉल्ट Base URL निर्धारित करता है |
| **आइकन** | विज़ुअल पहचान के लिए वैकल्पिक आइकन |
| **API कुंजी** | आपके प्रदाता के डैशबोर्ड से गुप्त कुंजी |
| **Base URL** | API एंडपॉइंट (बिल्ट-इन प्रकारों के लिए पूर्व-भरा) |
| **API पथ** | रिक्वेस्ट पथ — डिफ़ॉल्ट `/v1/chat/completions` |

---

## वेबसाइट लिंक से आयात करना

प्रदाता वेबसाइट, रिले सेवा डैशबोर्ड, निजी मॉडल प्लेटफ़ॉर्म या लोकल गेटवे पेज **AQBot में खोलें** लिंक दे सकते हैं। क्लिक करने पर ब्राउज़र AQBot डेस्कटॉप ऐप खोलता है, AQBot **Settings → Providers** पर जाता है, पुष्टि डायलॉग दिखाता है और उपयोगकर्ता की पुष्टि के बाद ही कॉन्फ़िगरेशन आयात करता है।

### उपयोगकर्ता प्रवाह

1. प्रदाता लिंक आयात सपोर्ट करने वाला AQBot संस्करण इंस्टॉल करके खोलें।
2. ब्राउज़र में प्रदाता का **AQBot में खोलें** लिंक क्लिक करें।
3. AQBot में प्रदाता नाम, Base URL, प्रदाता प्रकार और API key prefix जांचें।
4. AQBot समान **Base URL + प्रकार** वाले मौजूदा प्रदाता को पुनः उपयोग करता है। यदि वह मौजूद नहीं है, तो नया प्रदाता बनाता है और API key केवल तब जोड़ता है जब वह पहले से मौजूद न हो।

AQBot API key को अपने-आप validate नहीं करता और मॉडल सूची अपने-आप fetch नहीं करता। आयात के बाद **Fetch Models** क्लिक करें या मॉडल ID मैन्युअल रूप से जोड़ें।

### लिंक फ़ॉर्मेट

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

उदाहरण:

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### पैरामीटर

| पैरामीटर | आवश्यक | विवरण |
|----------|--------|-------|
| `name` | हाँ | AQBot में दिखने वाला नाम, जैसे `OpenAI` या `My Relay` |
| `baseurl` | हाँ | URL-encoded Base URL। केवल `http` और `https` स्वीकार हैं; query और hash अस्वीकार किए जाते हैं। |
| `apikey` | हाँ | AQBot में सेव की जाने वाली API key। पुष्टि डायलॉग में AQBot केवल prefix दिखाता है। |
| `type` | हाँ | प्रदाता प्रकार। मान्य values: `openai`, `openai_responses`, `anthropic`, `gemini`, `custom`. |

`baseurl` AQBot के मौजूदा force suffix का उपयोग कर सकता है, जैसे `https://example.com!`। लिंक से आयात करते समय `api_path` सेट नहीं होता; AQBot चुने गए प्रदाता प्रकार का डिफ़ॉल्ट path इस्तेमाल करता है।

### वेबसाइट कॉन्फ़िगरेशन

हर dynamic value को `encodeURIComponent` या `URLSearchParams` से encode करें:

```html
<a id="open-aqbot" href="#">AQBot में खोलें</a>

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

यदि आपका सेवा API key ऑनलाइन generate करती है, तो लिंक केवल उपयोगकर्ता के sign in करने और स्पष्ट रूप से key चुनने या बनाने के बाद generate करें।

::: warning सुरक्षा
URL में API key ब्राउज़र history, logs, extensions या analytics tools में दिखाई दे सकती है। असली keys को public pages, static HTML या third-party redirects में न डालें। बेहतर है कि लिंक private account page पर user confirmation के बाद generate किया जाए।
:::

::: tip टेस्टिंग
`aqbot://` एक custom protocol है जिसे installed desktop app सिस्टम में register करती है। केवल वेबसाइट या Vite dev server चलाने से protocol register नहीं होता। यदि link AQBot नहीं खोलता, तो पहले latest AQBot desktop app install या rebuild करें।
:::

---

## CC Switch से import

AQBot Settings -> Providers में CC Switch provider configurations स्कैन कर सकता है। हर candidate देखें, importable rows चुनें, फिर providers, Base URLs, API keys और model lists AQBot में import करें। OAuth-only entries या reusable keys के बिना entries visible reason के साथ skip होती हैं।

## Advanced model request body

हर model extra_body define कर सकता है, जो OpenAI-compatible Chat Completions requests में flat JSON object के रूप में जोड़ा जाता है। यह enable_thinking जैसे vendor-specific options के लिए उपयोगी है। AQBot JSON validate करता है और model, messages, stream, tools तथा base sampling fields overwrite होने से रोकता है।

## मल्टी-की रोटेशन

AQBot लोड वितरण के लिए प्रति प्रदाता कई API कीज़ सपोर्ट करता है। प्रदाता डिटेल पैनल में **Add Key** क्लिक करें।

---

## मॉडल प्रबंधन

उपलब्ध मॉडलों की पूरी सूची प्राप्त करने के लिए **Fetch Models** क्लिक करें। आप मॉडल ID मैन्युअल रूप से भी जोड़ सकते हैं।

---

## Ollama (लोकल मॉडल)

1. [Ollama](https://ollama.com/) इंस्टॉल और स्टार्ट करें।
2. AQBot में **OpenAI** प्रकार के साथ नया प्रदाता बनाएं।
3. **Base URL** को `http://localhost:11434` पर सेट करें।
4. लोकल रूप से डाउनलोड किए गए मॉडल खोजने के लिए **Fetch Models** क्लिक करें।

---

## अगले कदम

- [MCP सर्वर](./mcp) — AI क्षमताओं को बढ़ाने के लिए बाहरी टूल्स कनेक्ट करें
- [API गेटवे](./gateway) — अपने प्रदाताओं को लोकल API सर्वर के रूप में एक्सपोज़ करें
