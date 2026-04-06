# Características

AQBot es un asistente IA de escritorio completo que combina chat multi-proveedor, renderizado de contenido potente, integración de herramientas y una pasarela API integrada — todo funcionando localmente con sólida seguridad de datos.

## Chat y modelos

Conéctate a los principales proveedores de IA desde una única interfaz unificada.

- **Soporte multi-proveedor** — Compatible con OpenAI, Anthropic Claude, Google Gemini y todas las APIs compatibles con OpenAI.
- **Gestión de modelos** — Recuperación automática de listas de modelos remotos y personalización de parámetros de generación por conversación.
- **Rotación de claves múltiples** — Configura varias claves API por proveedor con rotación automática para distribuir la presión de límite de velocidad.
- **Salida en streaming** — Renderizado en tiempo real token por token. Bloques de pensamiento plegables para inspeccionar el razonamiento del modelo.
- **Versiones de mensajes** — Cada respuesta puede tener múltiples versiones. Compara los efectos de diferentes modelos o configuraciones de parámetros lado a lado.
- **Ramificación de conversaciones** — Crea una nueva rama desde cualquier nodo de mensaje. Vista de comparación de ramas lado a lado.
- **Gestión de conversaciones** — Fija conversaciones importantes, archiva las antiguas, navega por un historial agrupado por tiempo.
- **Compresión de conversaciones** — Comprime automáticamente conversaciones largas preservando información clave.
- **Respuesta simultánea multi-modelo** — Haz la misma pregunta a varios modelos a la vez con comparación lado a lado.

## Renderizado de contenido

AQBot va mucho más allá del chat de texto plano con un pipeline de renderizado rico e interactivo.

- **Renderizado Markdown** — Soporte completo para bloques de código con resaltado de sintaxis, fórmulas LaTeX, tablas y listas de tareas.
- **Editor de código Monaco** — Los bloques de código integran el editor Monaco (el motor de VS Code) con resaltado de sintaxis, copia con un clic y vista previa diff en línea.
- **Renderizado de diagramas** — Renderizado integrado para diagramas de flujo Mermaid y diagramas de arquitectura D2.
- **Panel Artifact** — Los fragmentos de código, borradores HTML, notas Markdown e informes se pueden abrir en un panel lateral dedicado.
- **Chat de voz en tiempo real** — (Próximamente) Conversaciones de voz WebRTC basadas en la API OpenAI Realtime.

## Búsqueda y conocimiento

Enriquece tus conversaciones con datos web en vivo, documentos locales y memoria persistente.

- **Búsqueda web** — Integración con Tavily, Zhipu WebSearch, Bocha y más.
- **Base de conocimiento local (RAG)** — Soporta múltiples bases de conocimiento. Sube documentos para análisis automático, fragmentación e indexación vectorial (sqlite-vec).
- **Sistema de memoria** — Soporta memoria conversacional multi-espacio de nombres. Las entradas se pueden añadir manualmente o extraer automáticamente por IA (próximamente).
- **Gestión de contexto** — Adjunta archivos, resultados de búsqueda, pasajes de la base de conocimiento y salidas de herramientas a cualquier mensaje.

::: tip Próximamente
La extracción automática de memoria por IA está en desarrollo activo y estará disponible en una próxima versión.
:::

## Herramientas y extensiones

Amplía las capacidades del modelo con herramientas externas y una poderosa interfaz de comandos.

- **Protocolo MCP** — Implementación completa del [Model Context Protocol](https://modelcontextprotocol.io/) con soporte para transportes **stdio** y **HTTP**.
- **Herramientas integradas** — Herramientas MCP integradas listas para usar como `@aqbot/fetch`.
- **Panel de ejecución de herramientas** — Un panel visual muestra cada solicitud de llamada de herramienta y su resultado de retorno.

## Pasarela API

AQBot incluye un servidor API local integrado que convierte tu aplicación de escritorio en una potente pasarela IA.

- **Pasarela API local** — Expone un servidor local con soporte nativo para interfaces compatibles con OpenAI, Claude y Gemini.
- **Gestión de claves API** — Genera, revoca y activa o desactiva claves de acceso.
- **Análisis de uso** — Analiza el volumen de solicitudes y el uso de tokens por clave, proveedor y fecha.
- **Soporte SSL/TLS** — Generación de certificado autofirmado integrada con soporte para importar certificados personalizados.
- **Registros de solicitudes** — Registro completo de cada solicitud y respuesta API que pasa por la pasarela.
- **Plantillas de configuración** — Plantillas de integración prediseñadas para Claude Code, Codex CLI, OpenCode y Gemini CLI.

::: tip ¿Por qué una pasarela local?
La pasarela te permite usar AQBot como backend IA unificado para todas tus herramientas. Configura tus clientes CLI, extensiones IDE o scripts personalizados para apuntar a la pasarela local y benefíciate de la rotación de claves, seguimiento de uso y control de acceso.
:::

## Datos y seguridad

Tus datos nunca abandonan tu máquina. AQBot está diseñado con seguridad local primero en cada capa.

- **Cifrado AES-256** — Las claves API y otros datos sensibles se cifran localmente con AES-256.
- **Directorios de datos aislados** — El estado de la aplicación reside en `~/.aqbot/`. Los archivos visibles al usuario se almacenan en `~/Documents/aqbot/`.
- **Copia de seguridad automática** — Programa copias de seguridad automáticas a directorios locales o almacenamiento WebDAV.
- **Restauración de copia de seguridad** — Restauración con un clic desde cualquier copia de seguridad histórica.
- **Exportación de conversaciones** — Exporta conversaciones como PNG, Markdown, texto plano o JSON estructurado.

::: warning Protege tu clave maestra
El archivo `~/.aqbot/master.key` es la raíz de todo el cifrado en AQBot. Guárdalo de forma segura e inclúyelo en tus copias de seguridad.
:::

## Experiencia de escritorio

AQBot está construido como una aplicación de escritorio nativa con el pulido e integración que esperas de una herramienta de uso diario.

- **Cambio de tema** — Temas oscuro y claro que siguen la preferencia del sistema o se pueden establecer manualmente.
- **Idioma de la interfaz** — Soporte completo para español, chino simplificado e inglés.
- **Bandeja del sistema** — Minimiza en la bandeja del sistema al cerrar la ventana. Los servicios en segundo plano continúan ejecutándose sin interrupciones.
- **Siempre visible** — Fija la ventana principal sobre todas las demás ventanas.
- **Atajos globales** — Atajos de teclado globales personalizables para invocar la ventana principal desde cualquier lugar.
- **Inicio automático** — Lanza AQBot opcionalmente al inicio del sistema.
- **Soporte de proxy** — Configura proxies HTTP y SOCKS5 para entornos con acceso de red restringido.
- **Actualizaciones automáticas** — AQBot comprueba automáticamente nuevas versiones al inicio.
