# Inicio rápido

## Instalación

Descarga el último instalador desde la [página de descarga](/es/download) o [GitHub Releases](https://github.com/AQBot-Desktop/AQBot/releases).

### macOS

| Chip | Archivo |
|------|---------|
| Apple Silicon (M1 / M2 / M3 / M4) | `AQBot_x.x.x_aarch64.dmg` |
| Intel | `AQBot_x.x.x_x64.dmg` |

1. Abre el `.dmg` y arrastra **AQBot** a la carpeta **Aplicaciones**.
2. Inicia AQBot. Si macOS bloquea la app, ve a **Configuración del Sistema → Privacidad y Seguridad** y haz clic en **Abrir de todas formas**.

::: warning macOS: "La app está dañada" o "No se puede verificar el desarrollador"
AQBot está firmado con el certificado de firma de código propio del proyecto, no con un certificado Apple Developer ID, por lo que tras descargarlo desde un navegador macOS puede seguir indicando que «AQBot está dañado y no puede abrirse» o que «No se puede abrir AQBot porque no se puede verificar el desarrollador».

No es necesario desactivar Gatekeeper en todo el sistema; permite solo AQBot:

1. En Finder, haz Control-clic en `AQBot.app`, elige **Abrir** y vuelve a hacer clic en **Abrir**.
2. Si sigue bloqueada, ve a **Configuración del Sistema → Privacidad y Seguridad**, busca AQBot en la sección **Seguridad** y haz clic en **Abrir de todas formas**.
3. Vuelve a iniciar AQBot.

La autorización de Gatekeeper y el permiso de Accesibilidad son ajustes independientes. Para usar la barra de herramientas de selección de texto, activa también AQBot en **Configuración del Sistema → Privacidad y Seguridad → Accesibilidad** cuando la app te lo indique.
:::

### Windows

| Arquitectura | Archivo |
|-------------|---------|
| x64 (la mayoría de PCs) | `AQBot_x.x.x_x64-setup.exe` |
| ARM64 | `AQBot_x.x.x_arm64-setup.exe` |

Ejecuta el instalador y sigue el asistente. Inicia AQBot desde el menú Inicio o el acceso directo del escritorio.

### Linux

| Formato | Arquitectura | Archivo |
|---------|-------------|---------|
| Debian / Ubuntu | x64 | `AQBot_x.x.x_amd64.deb` |
| Debian / Ubuntu | ARM64 | `AQBot_x.x.x_arm64.deb` |
| Fedora / openSUSE | x64 | `AQBot_x.x.x_x86_64.rpm` |
| Fedora / openSUSE | ARM64 | `AQBot_x.x.x_aarch64.rpm` |
| Cualquier distro | x64 | `AQBot_x.x.x_amd64.AppImage` |
| Cualquier distro | ARM64 | `AQBot_x.x.x_aarch64.AppImage` |

```bash
# Debian / Ubuntu
sudo dpkg -i AQBot_x.x.x_amd64.deb

# Fedora / openSUSE
sudo rpm -i AQBot_x.x.x_x86_64.rpm

# AppImage (cualquier distro)
chmod +x AQBot_x.x.x_amd64.AppImage
./AQBot_x.x.x_amd64.AppImage
```

---

## Configuración inicial

### 1. Abrir configuración

Inicia AQBot y haz clic en el **ícono de engranaje** en la parte inferior de la barra lateral, o presiona <kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd>.

### 2. Añadir un proveedor

Navega a **Configuración → Proveedores** y haz clic en el botón **+**.

1. Introduce un nombre para mostrar (ej. *OpenAI*).
2. Selecciona el tipo de proveedor (OpenAI, Anthropic, Google Gemini, etc.).
3. Pega tu clave API.
4. Confirma la **URL base** — el endpoint oficial está prellenado para los tipos integrados.

::: tip
Puedes añadir tantos proveedores como quieras. Cada proveedor gestiona su propio conjunto de claves API y modelos de forma independiente.
:::

### 3. Obtener modelos

Haz clic en **Obtener modelos** para obtener la lista de modelos disponibles de la API del proveedor. También puedes añadir IDs de modelos manualmente si es necesario.

### 4. Establecer un modelo predeterminado

Ve a **Configuración → Modelo predeterminado** y elige el proveedor y el modelo que las nuevas conversaciones deben usar por defecto.

---

## Tu primera conversación

1. Haz clic en **Nuevo chat** en la barra lateral (o presiona <kbd>Cmd/Ctrl</kbd>+<kbd>N</kbd>).
2. Selecciona un modelo del selector de modelos en la parte superior del chat.
3. Escribe un mensaje y presiona <kbd>Enter</kbd>.
4. AQBot transmite la respuesta en tiempo real. Los modelos que soportan bloques de pensamiento (ej. Claude, DeepSeek R1) muestran el proceso de razonamiento en una sección plegable.

---

## Atajos

| Atajo | Acción |
|-------|--------|
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> | Mostrar / ocultar ventana actual |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> | Mostrar / ocultar todas las ventanas |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | Cerrar ventana |
| <kbd>Cmd/Ctrl</kbd>+<kbd>N</kbd> | Nueva conversación |
| <kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd> | Abrir configuración |
| <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> | Paleta de comandos |
| <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Alternar pasarela API |

---

## Datos y copia de seguridad

### Directorios de datos

| Ruta | Contenido |
|------|----------|
| `~/.aqbot/` | Estado de la aplicación — base de datos, claves de cifrado, base vectorial, certificados SSL |
| `~/Documents/aqbot/` | Archivos de usuario — imágenes, documentos, copias de seguridad |

---

## Próximos pasos

- [Configurar proveedores](./providers) — añadir y gestionar proveedores de IA
- [Servidores MCP](./mcp) — conectar herramientas externas para ampliar las capacidades de IA
- [Pasarela API](./gateway) — exponer tus proveedores como servidor API local
