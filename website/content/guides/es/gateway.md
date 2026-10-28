# Pasarela API

## ¿Qué es la pasarela API?

AQBot incluye un servidor API local integrado que expone tus proveedores configurados como endpoints **compatibles con OpenAI**, **nativos de Claude** y **nativos de Gemini**. Cualquier herramienta o cliente que utilice uno de estos protocolos puede usar AQBot como backend — sin claves API separadas ni servicios de relé requeridos.

Casos de uso:

- Ejecuta **Claude Code CLI**, **OpenAI Codex CLI**, **Gemini CLI** u **OpenCode** a través de AQBot.
- Conecta tus extensiones IDE a un único endpoint gestionado localmente.
- Comparte un conjunto de claves de proveedor entre muchas herramientas con limitación de velocidad por clave.

---

## Comenzar

1. Abre **Configuración → Pasarela API** (o presiona <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>).
2. Haz clic en **Iniciar** para lanzar el servidor de pasarela.
3. Por defecto, el servidor escucha en `127.0.0.1:8080` (HTTP).

::: tip
Activa el **Inicio automático** en la configuración de la pasarela para iniciar el servidor automáticamente cuando AQBot se inicie.
:::

---

## Gestión de claves API

1. Ve a la pestaña **Claves API**.
2. Haz clic en **Generar nueva clave**.
3. Añade opcionalmente una **descripción** para identificar cada clave.
4. Copia la clave — solo se muestra una vez.

---

## Plantillas de configuración

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

### Cliente personalizado

```
URL base:  http://127.0.0.1:8080/v1
Clave API: aqbot-xxxx
```

---

## Próximos pasos

- [Inicio rápido](./getting-started) — volver a la guía de inicio rápido
- [Configurar proveedores](./providers) — añadir los proveedores upstream a los que enruta la pasarela
- [Servidores MCP](./mcp) — conectar herramientas externas para llamadas de herramientas IA
