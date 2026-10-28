# إعداد المزوّدين

يتصل AQBot بأي عدد من مزوّدي AI في آنٍ واحد. لكل مزوّد مفاتيح API الخاصة به وقائمة نماذج وإعدادات معاملات افتراضية.

## المزوّدون المدعومون

| المزوّد | نماذج مثال |
|---------|-----------|
| **OpenAI** | GPT-4o، GPT-4، o3، o4-mini |
| **Anthropic** | Claude 4 Sonnet، Claude 4 Opus، Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro، Gemini 2.5 Flash، Gemini 2.0 |
| **DeepSeek** | DeepSeek V3، DeepSeek R1 |
| **Alibaba Cloud** | سلسلة Qwen |
| **Zhipu AI** | سلسلة GLM |
| **xAI** | سلسلة Grok |
| **API متوافق مع OpenAI** | Ollama، vLLM، LiteLLM، وسطاء الطرف الثالث، إلخ |

---

## إضافة مزوّد

1. اذهب إلى **الإعدادات ← المزوّدون**.
2. انقر على زر **+** في أسفل اليسار.
3. امأ تفاصيل المزوّد:

| الحقل | الوصف |
|-------|-------|
| **الاسم** | اسم العرض في الشريط الجانبي (مثلاً *OpenAI*) |
| **النوع** | نوع المزوّد — يحدد Base URL الافتراضي |
| **الأيقونة** | أيقونة اختيارية للتعرّف البصري |
| **مفتاح API** | المفتاح السري من لوحة تحكم مزوّدك |
| **Base URL** | طرف API (مملوء مسبقاً للأنواع المدمجة) |
| **مسار API** | مسار الطلب — الافتراضي `/v1/chat/completions` |

---

## الاستيراد من رابط موقع ويب

يمكن لمواقع المزوّدين أو لوحات خدمات الوساطة أو منصات النماذج الخاصة أو صفحات البوابة المحلية توفير رابط **فتح في AQBot**. عند النقر عليه يفتح المتصفح تطبيق AQBot لسطح المكتب، وينتقل AQBot إلى **الإعدادات ← المزوّدون**، ويعرض مربع تأكيد، ثم يستورد الإعدادات فقط بعد تأكيد المستخدم.

### تدفق الاستخدام

1. ثبّت وافتح إصداراً من AQBot يدعم روابط المزوّدين.
2. انقر على رابط **فتح في AQBot** الذي يقدمه المزوّد في المتصفح.
3. راجع في AQBot اسم المزوّد و Base URL ونوع المزوّد وبادئة مفتاح API.
4. يعيد AQBot استخدام مزوّد موجود له نفس **Base URL + النوع**. إذا لم يوجد، ينشئ مزوّداً جديداً ويضيف مفتاح API فقط إذا لم يكن محفوظاً من قبل.

لا يتحقق AQBot من المفتاح تلقائياً ولا يجلب النماذج تلقائياً. بعد الاستيراد، انقر **جلب النماذج** أو أضف النماذج يدوياً.

### صيغة الرابط

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

مثال:

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### المعاملات

| المعامل | مطلوب | الوصف |
|---------|--------|-------|
| `name` | نعم | اسم العرض في AQBot، مثل `OpenAI` أو `My Relay` |
| `baseurl` | نعم | Base URL بعد ترميزه كرابط. يُقبل `http` و `https` فقط، ويتم رفض query و hash. |
| `apikey` | نعم | مفتاح API المراد حفظه في AQBot. يعرض AQBot البادئة فقط في مربع التأكيد. |
| `type` | نعم | نوع المزوّد. القيم المسموحة: `openai`، `openai_responses`، `anthropic`، `gemini`، `custom`. |

يمكن أن يستخدم `baseurl` لاحقة الإجبار الموجودة في AQBot، مثل `https://example.com!`. عند الاستيراد عبر الرابط لا يتم تعيين `api_path`، ويواصل AQBot استخدام المسار الافتراضي لنوع المزوّد المختار.

### إعداد الرابط في الموقع

قم بترميز كل القيم الديناميكية باستخدام `encodeURIComponent` أو `URLSearchParams`:

```html
<a id="open-aqbot" href="#">فتح في AQBot</a>

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

إذا كانت خدمتك تتيح إنشاء مفاتيح API عبر الإنترنت، فأنشئ الرابط فقط بعد تسجيل دخول المستخدم واختياره أو إنشائه للمفتاح بوضوح.

::: warning الأمان
قد يظهر مفتاح API الموجود في URL في سجل المتصفح أو السجلات أو الإضافات أو أدوات التحليلات. لا تضع مفاتيح حقيقية في صفحات عامة أو HTML ثابت أو روابط إعادة توجيه تابعة لطرف ثالث. من الأفضل إنشاء الرابط في صفحة حساب خاصة بعد تأكيد المستخدم.
:::

::: tip الاختبار
`aqbot://` بروتوكول مخصص يسجله تطبيق سطح المكتب المثبت في النظام. تشغيل الموقع أو خادم Vite فقط لا يسجل البروتوكول. إذا لم يفتح الرابط AQBot، فثبّت أو أعد بناء أحدث تطبيق AQBot لسطح المكتب أولاً.
:::

---

## Import من CC Switch

يمكن لـ AQBot فحص CC Switch provider configurations من Settings -> Providers. راجع كل candidate، اختر importable rows، ثم import providers وBase URLs وAPI keys وmodel lists إلى AQBot. يتم تخطي OAuth-only entries أو entries التي لا تحتوي على reusable keys مع سبب واضح.

## Advanced model request body

يمكن لكل model تعريف extra_body، وهو JSON object يضاف بشكل flat إلى OpenAI-compatible Chat Completions requests. يفيد ذلك في vendor-specific options مثل enable_thinking. يتحقق AQBot من JSON ويمنع overwrite للحقول model وmessages وstream وtools وbase sampling fields.

## تدوير مفاتيح متعددة

يدعم AQBot مفاتيح API متعددة لكل مزوّد. انقر **إضافة مفتاح** في لوحة تفاصيل المزوّد.

---

## إدارة النماذج

انقر **جلب النماذج** للحصول على القائمة الكاملة للنماذج المتاحة. يمكنك أيضاً إضافة معرّفات النماذج يدوياً.

---

## Ollama (النماذج المحلية)

1. ثبّت وأطلق [Ollama](https://ollama.com/).
2. في AQBot، أنشئ مزوّداً جديداً من النوع **OpenAI**.
3. اضبط **Base URL** على `http://localhost:11434`.
4. انقر **جلب النماذج** لاكتشاف النماذج المحمّلة محلياً.

---

## الخطوات التالية

- [خوادم MCP](./mcp) — توصيل أدوات خارجية لتوسيع قدرات AI
- [بوابة API](./gateway) — كشف مزوّديك كخادم API محلي
