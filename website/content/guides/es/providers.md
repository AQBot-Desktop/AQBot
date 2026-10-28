# Configurar proveedores

AQBot se conecta simultáneamente a cualquier número de proveedores de IA. Cada proveedor tiene sus propias claves API, lista de modelos y parámetros predeterminados.

## Proveedores soportados

| Proveedor | Modelos ejemplo |
|----------|----------------|
| **OpenAI** | GPT-4o, GPT-4, o3, o4-mini |
| **Anthropic** | Claude 4 Sonnet, Claude 4 Opus, Claude 3.5 Sonnet |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 |
| **DeepSeek** | DeepSeek V3, DeepSeek R1 |
| **Alibaba Cloud** | Serie Qwen |
| **Zhipu AI** | Serie GLM |
| **xAI** | Serie Grok |
| **API compatible OpenAI** | Ollama, vLLM, LiteLLM, relés de terceros, etc. |

---

## Añadir un proveedor

1. Ve a **Configuración → Proveedores**.
2. Haz clic en el botón **+** en la parte inferior izquierda.
3. Completa los detalles del proveedor:

| Campo | Descripción |
|-------|-------------|
| **Nombre** | Nombre para mostrar en la barra lateral (ej. *OpenAI*) |
| **Tipo** | Tipo de proveedor — determina la URL base predeterminada |
| **Ícono** | Ícono opcional para identificación visual |
| **Clave API** | La clave secreta del panel de tu proveedor |
| **URL base** | Endpoint API (prellenado para tipos integrados) |
| **Ruta API** | Ruta de solicitud — predeterminado `/v1/chat/completions` |

---

## Importar desde un enlace web

Los sitios de proveedores, paneles de servicios de relé, plataformas privadas de modelos o paneles de gateway local pueden ofrecer un enlace **Abrir en AQBot**. Al hacer clic, el navegador abre la app de escritorio AQBot, AQBot va a **Configuración → Proveedores**, muestra un diálogo de confirmación e importa la configuración solo después de que el usuario confirme.

### Flujo de usuario

1. Instala y abre una versión de AQBot compatible con enlaces de proveedor.
2. Haz clic en el enlace **Abrir en AQBot** del proveedor en el navegador.
3. Confirma el nombre, la URL base, el tipo de proveedor y el prefijo de la clave API en AQBot.
4. AQBot reutiliza un proveedor existente con la misma **URL base + tipo**. Si no existe, crea uno nuevo y añade la clave API solo si aún no está guardada.

AQBot no valida la clave ni obtiene modelos automáticamente. Después de importar, haz clic en **Obtener modelos** o añade modelos manualmente.

### Formato del enlace

```text
aqbot://providers?name=<name>&baseurl=<base-url>&apikey=<api-key>&type=<provider-type>
```

Ejemplo:

```text
aqbot://providers?name=OpenAI&baseurl=https%3A%2F%2Fapi.openai.com&apikey=sk-xxx&type=openai
```

### Parámetros

| Parámetro | Obligatorio | Descripción |
|-----------|-------------|-------------|
| `name` | Sí | Nombre visible en AQBot, por ejemplo `OpenAI` o `My Relay` |
| `baseurl` | Sí | URL base codificada. Solo se aceptan `http` y `https`; se rechazan query y hash. |
| `apikey` | Sí | Clave API que se guardará en AQBot. AQBot solo muestra un prefijo en el diálogo. |
| `type` | Sí | Tipo de proveedor. Valores permitidos: `openai`, `openai_responses`, `anthropic`, `gemini`, `custom`. |

`baseurl` puede usar el sufijo de fuerza existente de AQBot, por ejemplo `https://example.com!`. La importación por enlace no configura `api_path`; AQBot seguirá usando la ruta predeterminada del tipo de proveedor seleccionado.

### Configuración del sitio web

Codifica todos los valores dinámicos con `encodeURIComponent` o `URLSearchParams`:

```html
<a id="open-aqbot" href="#">Abrir en AQBot</a>

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

Si tu servicio permite generar claves API, crea el enlace solo después de que el usuario haya iniciado sesión y haya elegido o creado una clave explícitamente.

::: warning Seguridad
Una clave API dentro de una URL puede quedar en el historial del navegador, logs, extensiones o herramientas de analítica. No pongas claves reales en páginas públicas, HTML estático ni redirecciones de terceros. Es preferible generar el enlace en una página privada de cuenta después de confirmación del usuario.
:::

::: tip Pruebas
`aqbot://` es un protocolo personalizado registrado por la app de escritorio instalada. Ejecutar solo el sitio web o el servidor de desarrollo Vite no registra el protocolo. Si el enlace no abre AQBot, instala o recompila primero la app de escritorio más reciente.
:::

---

## Importar desde CC Switch

AQBot puede escanear configuraciones de proveedores de CC Switch desde Settings -> Providers. Revisa cada candidato, selecciona las filas importables e importa proveedores, Base URLs, API keys y listas de modelos. Las entradas OAuth-only o sin claves reutilizables se omiten con un motivo visible.

## Cuerpo de solicitud avanzado por modelo

Cada modelo puede definir extra_body, un objeto JSON que se añade plano a las solicitudes OpenAI-compatible Chat Completions. Es útil para opciones específicas del proveedor como enable_thinking. AQBot valida el JSON y bloquea la sobrescritura de model, messages, stream, tools y campos básicos de sampling.

## Rotación de claves múltiples

AQBot soporta múltiples claves API por proveedor. Haz clic en **Añadir clave** en el panel de detalles del proveedor.

---

## Gestión de modelos

Haz clic en **Obtener modelos** para obtener la lista completa de modelos disponibles. También puedes añadir IDs de modelos manualmente.

Cada modelo puede tener sus propias anulaciones de parámetros predeterminados: temperatura, tokens máximos, Top P, penalización de frecuencia, penalización de presencia.

---

## Endpoints personalizados y locales

### Ollama (modelos locales)

1. Instala e inicia [Ollama](https://ollama.com/).
2. En AQBot, crea un nuevo proveedor con tipo **OpenAI**.
3. Establece la **URL base** a `http://localhost:11434`.
4. Haz clic en **Obtener modelos** para descubrir los modelos descargados localmente.

---

## Próximos pasos

- [Servidores MCP](./mcp) — conectar herramientas externas para ampliar las capacidades de IA
- [Pasarela API](./gateway) — exponer tus proveedores como servidor API local
