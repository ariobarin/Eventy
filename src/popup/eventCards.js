export function createEventCard(
    ev,
    idx,
    {
        doc = document,
        escapeHtml,
        formatDateTime,
        onToggle = () => { },
    } = {}
) {
    const wrapper = doc.createElement("div");
    wrapper.className = "event-card";
    wrapper.dataset.idx = String(idx);

    const startStr = formatDateTime(ev.startDate || "", ev.startTime || "");
    const endStr = formatDateTime(
        ev.endDate || ev.startDate || "",
        ev.endTime || ""
    );
    const previewText = ev.preview || ev.title || "Untitled";
    const fullTitle = ev.title || "Untitled";
    const location = ev.location || "";
    const locationHtml = location
        ? `<div class="event-location" title="${escapeHtml(
            location
        )}">${escapeHtml(location)}</div>`
        : "";

    const recurrenceHtml = ev.recurrence
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="recurrence-icon" title="Recurring event"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`
        : "";

    wrapper.innerHTML = `
        <div class="event-row">
            <div class="event-title" title="${escapeHtml(
        fullTitle
    )}">${escapeHtml(previewText)}</div>
            <div class="event-bottom">
                <div class="event-times">
                    <div class="event-time start">
                        ${recurrenceHtml}
                        ${escapeHtml(startStr)}
                    </div>
                    ${endStr
            ? `<div class="event-time end">${escapeHtml(
                endStr
            )}</div>`
            : ""
        }
                </div>
                ${locationHtml}
            </div>
        </div>
    `;

    wrapper.addEventListener("click", () => {
        wrapper.classList.toggle("selected");
        onToggle(wrapper);
    });

    return wrapper;
}

export async function renderEventLists(
    events,
    {
        upcomingEventsListEl,
        pastEventsListEl,
        isEventPast,
        createCard,
        updateButtonStates,
    }
) {
    if (!upcomingEventsListEl || !pastEventsListEl) return;

    upcomingEventsListEl.innerHTML = "";
    pastEventsListEl.innerHTML = "";

    const upcomingEvents = [];
    const pastEvents = [];

    events.forEach((ev, idx) => {
        if (isEventPast(ev)) {
            pastEvents.push({ event: ev, originalIndex: idx });
        } else {
            upcomingEvents.push({ event: ev, originalIndex: idx });
        }
    });

    upcomingEvents.forEach(({ event: ev, originalIndex: idx }) => {
        upcomingEventsListEl.appendChild(createCard(ev, idx));
    });

    pastEvents.forEach(({ event: ev, originalIndex: idx }) => {
        pastEventsListEl.appendChild(createCard(ev, idx));
    });

    updateButtonStates();
}

export function scrollToCard(card) {
    const scrollContainer = card.closest(".events-list");
    if (scrollContainer) {
        requestAnimationFrame(() => {
            setTimeout(() => {
                const containerRect = scrollContainer.getBoundingClientRect();
                const cardRect = card.getBoundingClientRect();
                const currentScroll = scrollContainer.scrollTop;

                const cardCenter = cardRect.top + cardRect.height / 2;
                const containerCenter = containerRect.top + containerRect.height / 2;
                const diff = cardCenter - containerCenter;

                scrollContainer.scrollTo({
                    top: Math.max(0, currentScroll + diff),
                    behavior: "smooth",
                });
            }, 200);
        });
    }
}

export function restoreSelection(selectedIdxs, { resultsEl, updateButtonStates }) {
    if (!selectedIdxs?.length) return null;
    const cards = resultsEl?.querySelectorAll(".event-card");
    let firstSelected = null;
    if (cards) {
        cards.forEach((el) => el.classList.remove("selected"));
        selectedIdxs.forEach((i) => {
            const el = resultsEl?.querySelector(`.event-card[data-idx="${i}"]`);
            if (el) {
                el.classList.add("selected");
                if (!firstSelected) firstSelected = el;
            }
        });
    }
    updateButtonStates();
    return firstSelected;
}
