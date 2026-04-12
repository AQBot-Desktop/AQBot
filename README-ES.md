[简体中文](./README.md) | [繁體中文](./README-ZH-TW.md) | [English](./README-EN.md) | [日本語](./README-JA.md) | [한국어](./README-KO.md) | [Français](./README-FR.md) | [Deutsch](./README-DE.md) | **Español** | [Русский](./README-RU.md) | [हिन्दी](./README-HI.md) | [العربية](./README-AR.md)

[![AQBot](https://socialify.git.ci/AQBot-Desktop/AQBot/image?description=1&font=JetBrains+Mono&forks=1&issues=1&logo=https%3A%2F%2Fgithub.com%2FAQBot-Desktop%2FAQBot%2Fblob%2Fmain%2Fsrc%2Fassets%2Fimage%2Flogo.png%3Fraw%3Dtrue&name=1&owner=1&pattern=Floating+Cogs&pulls=1&stargazers=1&theme=Auto)](https://github.com/AQBot-Desktop/AQBot)

<p align="center">
    <a href="https://www.producthunt.com/products/aqbot?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-aqbot" target="_blank" rel="noopener noreferrer"><img alt="AQBot - Lightweight, high-perf cross-platform AI desktop client | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1118403&amp;theme=light&amp;t=1775627359538"></a>
</p>

## Capturas de pantalla

| Renderizado de gráficos de chat | Proveedores y modelos |
|:---:|:---:|
| ![](.github/images/s1.png) | ![](.github/images/s2.png) |

| Base de conocimientos | Memoria |
|:---:|:---:|
| ![](.github/images/s3.png) | ![](.github/images/s4.png) |

| Agent - Consulta | Acceso rápido a API Gateway |
|:---:|:---:|
| ![](.github/images/s5.png) | ![](.github/images/s6.png) |

| Selección de modelo de chat | Navegación de chats |
|:---:|:---:|
| ![](.github/images/s7.png) | ![](.github/images/s8.png) |

| Agent - Aprobación de permisos | Resumen de API Gateway |
|:---:|:---:|
| ![](.github/images/s9.png) | ![](.github/images/s10.png) |

## Características

### Chat y modelos

- **Soporte multi-proveedor** — Compatible con OpenAI, Anthropic Claude, Google Gemini y todas las APIs compatibles con OpenAI
- **Gestión de modelos** — Obtener listas de modelos remotos, personalizar parámetros (temperatura, tokens máximos, Top-P, etc.)
- **Rotación multi-clave** — Configurar múltiples claves API por proveedor con rotación automática para distribuir la presión del límite de velocidad
- **Salida en streaming** — Renderizado en tiempo real token a token con bloques de pensamiento plegables
- **Versiones de mensajes** — Cambiar entre múltiples versiones de respuesta por mensaje para comparar efectos de modelos o parámetros
- **Ramificación de conversación** — Crear nuevas ramas desde cualquier nodo de mensaje, con comparación de ramas en paralelo
- **Gestión de conversaciones** — Fijar, archivar, visualización agrupada por tiempo y operaciones masivas
- **Compresión de conversación** — Comprimir automáticamente conversaciones largas preservando información clave para ahorrar espacio de contexto
- **Respuesta simultánea multi-modelo** — Hacer la misma pregunta a múltiples modelos a la vez, con comparación de respuestas en paralelo

### AI Agent

- **Modo Agent** — Cambia al modo Agent para la ejecución autónoma de tareas de múltiples pasos: leer/escribir archivos, ejecutar comandos, analizar código y más
- **Tres niveles de permisos** — Predeterminado (escrituras necesitan aprobación), Aceptar ediciones (aprobar cambios de archivos automáticamente), Acceso completo (sin indicaciones) — seguro y controlable
- **Sandbox de directorio de trabajo** — Las operaciones del Agent están estrictamente limitadas al directorio de trabajo especificado, previniendo el acceso no autorizado
- **Panel de aprobación de herramientas** — Visualización en tiempo real de solicitudes de llamadas a herramientas con revisión individual, "permitir siempre" con un clic, o denegar
- **Seguimiento de costos** — Estadísticas de uso de tokens y costos en tiempo real por sesión

### Renderizado de contenido

- **Renderizado Markdown** — Soporte completo para resaltado de código, fórmulas matemáticas LaTeX, tablas y listas de tareas
- **Editor de código Monaco** — Monaco Editor integrado en bloques de código con resaltado de sintaxis, copia y vista previa diff
- **Renderizado de diagramas** — Renderizado integrado de diagramas de flujo Mermaid y diagramas de arquitectura D2
- **Panel Artifact** — Fragmentos de código, borradores HTML, notas Markdown e informes visualizables en un panel dedicado
- **Chat de voz en tiempo real** — (Próximamente) Voz en tiempo real basada en WebRTC con soporte de la API OpenAI Realtime

### Búsqueda y conocimiento

- **Búsqueda web** — Integrado con Tavily, Zhipu WebSearch, Bocha y más, con anotaciones de fuentes de cita
- **Base de conocimiento local (RAG)** — Soporta múltiples bases de conocimiento; cargar documentos para análisis, fragmentación e indexación automáticos, con recuperación semántica de pasajes relevantes durante las conversaciones
- **Sistema de memoria** — Soporta memoria de conversación multi-espacio de nombres, con entrada manual o extracción automática por IA (extracción automática próximamente)
- **Gestión de contexto** — Adjuntar de forma flexible archivos adjuntos, resultados de búsqueda, pasajes de la base de conocimiento, entradas de memoria y salidas de herramientas

### Herramientas y extensiones

- **Protocolo MCP** — Implementación completa del Model Context Protocol con soporte para transportes stdio y HTTP
- **Herramientas integradas** — Herramientas MCP integradas listas para usar como `@aqbot/fetch`
- **Panel de ejecución de herramientas** — Visualización de solicitudes de llamadas a herramientas y resultados devueltos

### Pasarela API

- **Pasarela API local** — Servidor API local integrado con soporte nativo para interfaces compatibles con OpenAI, Claude y Gemini, utilizable como backend para cualquier cliente compatible
- **Gestión de claves API** — Generar, revocar y habilitar/deshabilitar claves de acceso con notas descriptivas
- **Análisis de uso** — Análisis de volumen de solicitudes y uso de tokens por clave, proveedor y fecha
- **Soporte SSL/TLS** — Generación integrada de certificados autofirmados, con soporte para certificados personalizados
- **Registros de solicitudes** — Registro completo de todas las solicitudes y respuestas de la API que pasan por la pasarela
- **Plantillas de configuración** — Plantillas de integración prediseñadas para herramientas CLI populares como Claude, Codex, OpenCode y Gemini

### Datos y seguridad

- **Cifrado AES-256** — Las claves API y los datos sensibles se cifran localmente con AES-256; clave maestra almacenada con permisos 0600
- **Directorios de datos aislados** — Estado de la aplicación en `~/.aqbot/`; archivos de usuario en `~/Documents/aqbot/`
- **Copia de seguridad automática** — Copias de seguridad automáticas programadas en directorios locales o almacenamiento WebDAV
- **Restauración de copia de seguridad** — Restauración con un clic desde copias de seguridad históricas
- **Exportación de conversación** — Exportar conversaciones como capturas PNG, Markdown, texto plano o JSON

### Experiencia de escritorio

- **Cambio de tema** — Temas oscuro/claro que siguen las preferencias del sistema o se pueden configurar manualmente
- **Idioma de la interfaz** — Soporte completo para chino simplificado, chino tradicional, inglés, japonés, coreano, francés, alemán, español, ruso, hindi y árabe, cambiable en cualquier momento en la configuración
- **Bandeja del sistema** — Minimizar a la bandeja del sistema al cerrar la ventana sin interrumpir los servicios en segundo plano
- **Siempre visible** — Fijar la ventana principal para que permanezca sobre todas las demás ventanas
- **Atajos globales** — Atajos de teclado globales personalizables para invocar la ventana principal en cualquier momento
- **Inicio automático** — Lanzamiento opcional al iniciar el sistema
- **Soporte de proxy** — Configuración de proxy HTTP y SOCKS5
- **Actualización automática** — Verifica automáticamente nuevas versiones al inicio y solicita actualización

## Plataformas compatibles

| Plataforma | Arquitectura |
|------------|-------------|
| macOS | Apple Silicon (arm64), Intel (x86_64) |
| Windows 10/11 | x86_64, arm64 |
| Linux | x86_64 (AppImage/deb/rpm), arm64 (AppImage/deb/rpm) |

## Primeros pasos

Ve a la página de [Releases](https://github.com/AQBot-Desktop/AQBot/releases) y descarga el instalador para tu plataforma.

## Preguntas frecuentes

### macOS: «La app está dañada» o «No se puede verificar al desarrollador»

Dado que la aplicación no está firmada por Apple, macOS puede mostrar uno de los siguientes mensajes:

- «AQBot» está dañado y no se puede abrir
- «AQBot» no se puede abrir porque Apple no puede comprobar si contiene software malicioso

**Pasos para resolver el problema:**

**1. Permitir apps de «Cualquier origen»**

```bash
sudo spctl --master-disable
```

Luego ve a **Configuración del sistema → Privacidad y seguridad → Seguridad** y selecciona **Cualquier origen**.

**2. Eliminar el atributo de cuarentena**

```bash
sudo xattr -dr com.apple.quarantine /Applications/AQBot.app
```

> Consejo: Puedes arrastrar el ícono de la app al terminal después de escribir `sudo xattr -dr com.apple.quarantine `.

**3. Paso adicional para macOS Ventura y versiones posteriores**

Después de completar los pasos anteriores, es posible que el primer lanzamiento aún esté bloqueado. Ve a **Configuración del sistema → Privacidad y seguridad** y haz clic en **Abrir igualmente** en la sección de Seguridad. Esto solo debe hacerse una vez.

## Comunidad
- [LinuxDO](https://linux.do)

## Licencia

Este proyecto está bajo la licencia [AGPL-3.0](LICENSE).
