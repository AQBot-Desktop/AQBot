// MCP Bridge: Enables eval() contexts to communicate with Tauri IPC
// This bridge is automatically injected by the mcp-bridge plugin
// It forwards DOM events from eval() contexts to Tauri IPC and back

(function() {
   'use strict';

   var origLog, origDebug, origInfo, origWarn, origError;

   // Initialize console capture so logs are captured from app startup
   function initConsoleCapture() {
      var args, message;

      if (window.__MCP_CONSOLE_LOGS__) {
         return; // Already initialized
      }

      origLog = console.log;
      origDebug = console.debug;
      origInfo = console.info;
      origWarn = console.warn;
      origError = console.error;

      window.__MCP_CONSOLE_LOGS__ = [];

      function captureLog(level, origFn) {
         return function() {
            args = Array.prototype.slice.call(arguments);

            try {
               message = args
                  .map(function(a) {
                     return typeof a === 'object' ? JSON.stringify(a) : String(a);
                  })
                  .join(' ');
            } catch(e) {
               message = args.map(String).join(' ');
            }

            window.__MCP_CONSOLE_LOGS__.push({
               level: level,
               message: message,
               timestamp: Date.now(),
            });

            origFn.apply(console, args);
         };
      }

      console.log = captureLog('log', origLog);
      console.debug = captureLog('debug', origDebug);
      console.info = captureLog('info', origInfo);
      console.warn = captureLog('warn', origWarn);
      console.error = captureLog('error', origError);

      console.log('[MCP Bridge] Console capture initialized');
   }

   // Wait for Tauri API to be available
   function waitForTauri(callback) {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
         // eslint-disable-next-line callback-return
         callback();
      } else {
         setTimeout(function() {
            waitForTauri(callback);
         }, 50);
      }
   }

   waitForTauri(function() {
      console.log('[MCP Bridge] Tauri API available, initializing bridge');

      // Initialize console capture immediately so logs are captured from the start
      initConsoleCapture();

      // Listen for execution requests from eval() contexts
      window.addEventListener('__mcp_exec_request', async function(event) {
         const request = event.detail;

         console.log('[MCP Bridge] Received request:', request);

         try {
            // Forward to Tauri IPC using the global API
            const result = await window.__TAURI__.core.invoke(
               request.command,
               request.args
            );

            console.log('[MCP Bridge] Command succeeded, sending response');

            // Send success response back via DOM event
            window.dispatchEvent(new CustomEvent('__mcp_exec_response', {
               detail: {
                  execId: request.execId,
                  success: true,
                  data: result,
               },
            }));
         } catch(error) {
            console.error('[MCP Bridge] Command failed:', error);

            // Send error response back via DOM event
            window.dispatchEvent(new CustomEvent('__mcp_exec_response', {
               detail: {
                  execId: request.execId,
                  success: false,
                  error: error.message || String(error),
               },
            }));
         }
      });

      // Mark bridge as ready
      window.__MCP_BRIDGE_READY__ = true;
      console.log('[MCP Bridge] Ready');

      // Notify Rust that the page has loaded and scripts should be re-injected
      // This is called after the bridge is ready to ensure Tauri IPC is available
      notifyPageLoaded();
   });

   // =========================================================================
   // Script Injection Functions
   // =========================================================================

   /**
    * Injects scripts into the DOM. Called by Rust when scripts need to be injected.
    * @param {Array<{id: string, type: 'inline'|'url', content: string}>} scripts
    */
   window.__MCP_INJECT_SCRIPTS__ = function(scripts) {
      var script;

      if (!Array.isArray(scripts)) {
         console.error('[MCP Bridge] Invalid scripts array');
         return;
      }

      scripts.forEach(function(entry) {
         if (!entry || !entry.id) {
            return;
         }

         // Check if script already exists
         if (document.querySelector('script[data-mcp-script-id="' + entry.id + '"]')) {
            console.log('[MCP Bridge] Script already exists:', entry.id);
            return;
         }

         script = document.createElement('script');

         script.setAttribute('data-mcp-script-id', entry.id);

         if (entry.type === 'url') {
            script.src = entry.content;
            script.async = true;
            script.onload = function() {
               console.log('[MCP Bridge] URL script loaded:', entry.id);
            };
            script.onerror = function() {
               console.error('[MCP Bridge] Failed to load URL script:', entry.id);
            };
         } else {
            // Inline script
            script.textContent = entry.content;
         }

         document.head.appendChild(script);
         console.log('[MCP Bridge] Injected script:', entry.id);
      });
   };

   /**
    * Removes a script from the DOM by ID.
    * @param {string} scriptId
    */
   window.__MCP_REMOVE_SCRIPT__ = function(scriptId) {
      var script = document.querySelector('script[data-mcp-script-id="' + scriptId + '"]');

      if (script) {
         script.remove();
         console.log('[MCP Bridge] Removed script:', scriptId);
      }
   };

   /**
    * Removes all MCP-managed scripts from the DOM.
    */
   window.__MCP_CLEAR_SCRIPTS__ = function() {
      var scripts = document.querySelectorAll('script[data-mcp-script-id]');

      scripts.forEach(function(s) {
         s.remove();
      });
      console.log('[MCP Bridge] Cleared', scripts.length, 'scripts');
   };

   /**
    * Notifies Rust that the page has loaded and scripts should be re-injected.
    * Uses the Tauri event system to communicate with the plugin.
    */
   function notifyPageLoaded() {
      // Use Tauri's invoke to request script re-injection.
      // The plugin responds by calling __MCP_INJECT_SCRIPTS__ with registered scripts.
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
         window.__TAURI__.core.invoke('plugin:mcp-bridge|request_script_injection')
            .catch(function(err) {
               // This command may not exist in older versions, which is fine
               console.log('[MCP Bridge] Script injection request:', err.message || 'not available');
            });
      }
   }

   // Also listen for navigation events to re-inject scripts
   // This handles SPA-style navigation where the page doesn't fully reload
   window.addEventListener('popstate', function() {
      console.log('[MCP Bridge] Navigation detected (popstate)');
      notifyPageLoaded();
   });
}());
