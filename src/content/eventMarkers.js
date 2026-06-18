// Content script for injecting event markers on the webpage
(function () {
    // Prevent multiple injections
    if (window.__eventyMarkersInjected) return;
    window.__eventyMarkersInjected = true;

    const MARKER_CLASS = "eventy-event-marker";
    const MARKER_CONTAINER_ID = "eventy-markers-container";
    const MARKER_SIZE_PX = 22;
    const MARKER_GAP_PX = 6;

    // Track used elements to avoid duplicates for similar events
    let usedElements = new Set();

    // Track the message listener to prevent accumulation on re-injection
    let messageListener = null;

    // Create a container for all markers (uses shadow DOM for style isolation)
    function createMarkersContainer() {
        let container = document.getElementById(MARKER_CONTAINER_ID);
        if (container) return container;

        container = document.createElement("div");
        container.id = MARKER_CONTAINER_ID;

        // Use shadow DOM to isolate styles
        const shadow = container.attachShadow({ mode: "closed" });

        // Inject styles into shadow DOM
        const style = document.createElement("style");
        style.textContent = `
            .eventy-event-marker {
                position: absolute;
                width: ${MARKER_SIZE_PX}px;
                height: ${MARKER_SIZE_PX}px;
                background: linear-gradient(135deg, #FF915B 0%, #FF6B35 45%, #FF3D6C 100%);
                border: 1px solid rgba(0, 0, 0, 0.28);
                border-radius: 999px;
                cursor: pointer;
                z-index: 2147483647;
                display: flex;
                align-items: center;
                justify-content: center;
                filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.28));
                transition: transform 160ms ease, filter 160ms ease;
                pointer-events: auto;
                user-select: none;
                -webkit-tap-highlight-color: transparent;
            }
            .eventy-event-marker:hover {
                transform: scale(1.12);
                filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.32));
            }
            .eventy-event-marker:active {
                transform: scale(1.06);
                filter: drop-shadow(0 3px 10px rgba(0, 0, 0, 0.3));
            }
            .eventy-event-marker:focus-visible {
                outline: none;
                box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 0 0 4px rgba(255, 107, 53, 0.4);
            }
            .eventy-event-marker svg {
                width: 14px;
                height: 14px;
                color: rgba(255, 255, 255, 0.96);
                filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.22));
            }
            .eventy-markers-wrapper {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 2147483647;
            }
        `;
        shadow.appendChild(style);

        // Create wrapper inside shadow DOM
        const wrapper = document.createElement("div");
        wrapper.className = "eventy-markers-wrapper";
        shadow.appendChild(wrapper);

        container._shadowWrapper = wrapper;
        document.body.appendChild(container);

        return container;
    }

    function normalizeText(text) {
        return text.toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[\u2013\u2014]/g, '-')
            .trim();
    }

    // Find all text nodes that match a search term
    function findAllMatchingTextNodes(searchText) {
        const matches = [];
        if (!searchText || searchText.length < 3) return matches;

        const normalizedSearch = normalizeText(searchText);
        // Use first 15 chars to increase match rate for split nodes
        const searchPrefix = normalizedSearch.substring(0, 15);

        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    const tag = parent.tagName.toLowerCase();
                    if (["script", "style", "noscript", "template", "iframe"].includes(tag)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    const text = normalizeText(node.textContent || "");
                    if (text.length > 0 && text.includes(searchPrefix)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            }
        );

        let node;
        while ((node = walker.nextNode())) {
            if (node.parentElement) {
                matches.push(node);
            }
        }
        return matches;
    }

    // Get the closest inline or heading element (the actual title element)
    function getTitleElement(textNode) {
        let el = textNode.parentElement;
        while (el && el !== document.body) {
            const tag = el.tagName.toLowerCase();
            // Prefer heading elements or inline elements
            if (["h1", "h2", "h3", "h4", "h5", "h6", "a", "span", "strong", "b", "em"].includes(tag)) {
                return el;
            }
            // Stop at block-level containers
            const display = window.getComputedStyle(el).display;
            if (["block", "flex", "grid", "list-item", "inline-block", "table-cell"].includes(display)) {
                // Return the first child that contains our text
                return el;
            }
            el = el.parentElement;
        }
        return textNode.parentElement;
    }

    // Find the best DOM element for an event, avoiding already-used elements
    function findEventElement(event, usedElements) {
        const title = event.title || event.preview || "";
        const startDate = event.startDate || "";
        const startTime = event.startTime || "";
        
        if (!title) return null;

        // Find all nodes matching the title
        const titleMatches = findAllMatchingTextNodes(title);
        
        // If we have date/time, use them to disambiguate
        const dateMatches = startDate ? findAllMatchingTextNodes(startDate) : [];
        const timeMatches = startTime ? findAllMatchingTextNodes(startTime) : [];

        // Score each title match based on proximity to date/time elements
        let bestMatch = null;
        let bestScore = -1;

        for (const titleNode of titleMatches) {
            const titleEl = getTitleElement(titleNode);
            if (!titleEl || usedElements.has(titleEl)) continue;

            let score = 1;

            // Check if date/time elements are nearby (within same container)
            const container = titleEl.closest("article, section, div, li, tr, td") || titleEl.parentElement;
            
            if (container) {
                // Bonus for having date nearby
                for (const dateNode of dateMatches) {
                    if (container.contains(dateNode)) {
                        score += 2;
                        break;
                    }
                }
                // Bonus for having time nearby
                for (const timeNode of timeMatches) {
                    if (container.contains(timeNode)) {
                        score += 2;
                        break;
                    }
                }
            }

            // Prefer elements that haven't been used
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { element: titleEl, textNode: titleNode };
            }
        }

        // If no title match found with good score, try fallback
        if (!bestMatch && titleMatches.length > 0) {
            for (const titleNode of titleMatches) {
                const titleEl = getTitleElement(titleNode);
                if (titleEl && !usedElements.has(titleEl)) {
                    bestMatch = { element: titleEl, textNode: titleNode };
                    break;
                }
            }
        }

        return bestMatch;
    }

    // Create a marker element
    function createMarker(eventIndex, event) {
        const marker = document.createElement("div");
        marker.className = MARKER_CLASS;
        marker.dataset.eventIndex = eventIndex;
        marker.title = event.title || event.preview || "Event";
        marker.tabIndex = 0;
        marker.setAttribute("role", "button");
        marker.setAttribute("aria-label", `Open Eventy for: ${marker.title}`);

        // Plus icon SVG
        marker.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                <line x1="12" y1="7" x2="12" y2="17"></line>
                <line x1="7" y1="12" x2="17" y2="12"></line>
            </svg>
        `;

        marker.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                marker.click();
            }
        });

        marker.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Send message to background to open popup with this event selected
            chrome.runtime.sendMessage({
                action: "openPopupWithEvent",
                eventIndex: eventIndex,
                tabUrl: window.location.href
            });
        });

        return marker;
    }

    // Position a marker to the right of the element's text
    function positionMarker(marker, target) {
        let rect;
        
        // If target is a text node, use Range to get its bounding rect
        if (target.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            range.selectNodeContents(target);
            rect = range.getBoundingClientRect();
        } else {
            rect = target.getBoundingClientRect();
        }

        const scrollX = window.scrollX || window.pageXOffset;
        const scrollY = window.scrollY || window.pageYOffset;

        // Position immediately to the right of the text/element
        // with a small gap
        marker.style.left = `${rect.right + scrollX + MARKER_GAP_PX}px`;
        marker.style.top = `${rect.top + scrollY + (rect.height / 2) - (MARKER_SIZE_PX / 2)}px`;
    }

    // Inject markers for all events
    function injectMarkers(events) {
        // Remove any existing markers first
        removeMarkers();

        if (!events || events.length === 0) return;

        // Reset used elements tracking
        usedElements = new Set();

        const container = createMarkersContainer();
        const wrapper = container._shadowWrapper;

        events.forEach((event, index) => {
            const match = findEventElement(event, usedElements);
            if (!match) return;

            // Mark this element as used
            usedElements.add(match.element);

            const marker = createMarker(index, event);
            wrapper.appendChild(marker);
            
            // Use textNode for positioning if available, otherwise element
            const targetNode = match.textNode || match.element;
            positionMarker(marker, targetNode);

            // Store reference for repositioning on scroll/resize
            marker._targetNode = targetNode;
        });

        // Update positions on scroll and resize
        const updatePositions = () => {
            const markers = wrapper.querySelectorAll(`.${MARKER_CLASS}`);
            markers.forEach((marker) => {
                if (marker._targetNode) {
                    positionMarker(marker, marker._targetNode);
                }
            });
        };

        window.addEventListener("scroll", updatePositions, { passive: true });
        window.addEventListener("resize", updatePositions, { passive: true });

        // Store cleanup function
        container._cleanup = () => {
            window.removeEventListener("scroll", updatePositions);
            window.removeEventListener("resize", updatePositions);
        };
    }

    // Remove all markers
    function removeMarkers() {
        const container = document.getElementById(MARKER_CONTAINER_ID);
        if (container) {
            if (container._cleanup) container._cleanup();
            container.remove();
        }
        usedElements = new Set();
        // Remove the message listener to prevent accumulation on re-injection
        if (messageListener) {
            chrome.runtime.onMessage.removeListener(messageListener);
            messageListener = null;
        }
        window.__eventyMarkersInjected = false;
    }

    // Listen for messages from background/popup
    messageListener = (request, sender, sendResponse) => {
        if (request.action === "injectEventMarkers") {
            injectMarkers(request.events);
            sendResponse({ success: true });
            return true;
        }

        if (request.action === "removeEventMarkers") {
            removeMarkers();
            sendResponse({ success: true });
            return true;
        }

        if (request.action === "checkMarkersInjected") {
            sendResponse({ injected: !!document.getElementById(MARKER_CONTAINER_ID) });
            return true;
        }
    };
    chrome.runtime.onMessage.addListener(messageListener);
})();
