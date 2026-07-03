const EVENT_COLORS = [
    { hex: '#FF8A3D', ink: '#D9701E', rgba: 'rgba(255,138,61,.42)' },
    { hex: '#21BEC4', ink: '#128A90', rgba: 'rgba(33,190,196,.40)' },
    { hex: '#9B6BE0', ink: '#7E50C8', rgba: 'rgba(155,107,224,.40)' },
    { hex: '#F0479A', ink: '#D62E84', rgba: 'rgba(240,71,154,.38)' },
];

const PAST_COLOR = { hex: '#9AA7A0', ink: '#8A968F', rgba: 'rgba(154,167,160,.30)' };

let colorIndex = 0;

export function resetColorIndex() {
    colorIndex = 0;
}

export function assignEventColor(isPast) {
    if (isPast) return PAST_COLOR;
    const c = EVENT_COLORS[colorIndex % EVENT_COLORS.length];
    colorIndex++;
    return c;
}

export function createEventCard(
    ev,
    idx,
    {
        doc = document,
        escapeHtml,
        formatTimeOnly,
        onToggle = () => { },
        color = null,
        isPast = false,
    } = {}
) {
    const c = color || assignEventColor(isPast);
    const wrapper = doc.createElement('div');
    wrapper.className = 'event-card';
    wrapper.dataset.idx = String(idx);
    wrapper.dataset.color = c.hex;
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-pressed', 'false');

    const startTime = formatTimeOnly(ev.startTime || '');
    const endTime = formatTimeOnly(ev.endTime || '');
    const location = ev.location || '';
    const title = ev.title || 'Untitled';
    const monthAbbr = formatMonthAbbr(ev.startDate);
    const dayNum = formatDayNum(ev.startDate);

    // Time range including end time
    let timeRange = '';
    if (startTime && endTime) timeRange = `${startTime} – ${endTime}`;
    else if (startTime) timeRange = startTime;
    else if (endTime) timeRange = endTime;

    // Build note HTML: bold time · location — description
    const noteHtmlParts = [];
    if (timeRange) noteHtmlParts.push(`<span class="ev-time">${escapeHtml(timeRange)}</span>`);
    if (location) noteHtmlParts.push(escapeHtml(location));
    let noteHtml = noteHtmlParts.join(' · ');
    if (ev.description && ev.description.length < 40) {
        noteHtml += noteHtml ? ' — ' + escapeHtml(ev.description) : escapeHtml(ev.description);
    }

    // Highlighter swipe on title (for non-past events with color)
    const titleHtml = !isPast
        ? `<span class="ev-title-highlight" style="background:linear-gradient(180deg,transparent 52%,${c.rgba} 52%,${c.rgba} 92%,transparent 92%)">${escapeHtml(title)}</span>`
        : escapeHtml(title);

    // Recurrence badge
    const badgeHtml = ev.recurrence
        ? `<span class="ev-badge">Recurring</span>`
        : '';

    // Multi-day badge
    const multiDayHtml = (ev.startDate && ev.endDate && ev.endDate !== ev.startDate)
        ? `<span class="ev-badge">Multi-day</span>`
        : '';

    wrapper.innerHTML = `
        <div class="date-chip">
            <div class="date-chip-month" style="background:${c.hex}">${escapeHtml(monthAbbr)}</div>
            <div class="date-chip-day">${escapeHtml(dayNum)}</div>
        </div>
        <div class="ev-content">
            <div class="ev-title">${titleHtml}</div>
            ${noteHtml ? `<div class="ev-note" style="color:${c.ink}">${noteHtml}</div>` : ''}
            ${badgeHtml}${multiDayHtml}
        </div>
    `;

    const toggleSelected = () => {
        const selected = wrapper.classList.toggle('selected');
        wrapper.setAttribute('aria-pressed', String(selected));
        onToggle(wrapper);
    };

    wrapper.addEventListener('click', toggleSelected);
    wrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSelected();
        }
    });

    return wrapper;
}

function formatMonthAbbr(dateStr) {
    if (!dateStr) return '???';
    try {
        const d = new Date(`${dateStr}T00:00:00`);
        if (isNaN(d.getTime())) return '???';
        return ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
            'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
    } catch { return '???'; }
}

function formatDayNum(dateStr) {
    if (!dateStr) return '??';
    try {
        const d = new Date(`${dateStr}T00:00:00`);
        if (isNaN(d.getTime())) return '??';
        return String(d.getDate()).padStart(2, '0');
    } catch { return '??'; }
}

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

function monthKeyFromEvent(ev) {
    const s = ev?.startDate;
    if (!s) return 'no-date';
    return String(s).slice(0, 7);
}

function createMonthSectionHeader(ev) {
    const header = document.createElement('div');
    header.className = 'month-section-header';
    const s = ev?.startDate;
    let label = 'No date';
    let yearHtml = '';
    if (s) {
        const d = new Date(`${s}T00:00:00`);
        if (!isNaN(d.getTime())) {
            label = MONTHS_FULL[d.getMonth()].toUpperCase();
            yearHtml = ` <span class="month-year">${d.getFullYear()}</span>`;
        }
    }
    header.innerHTML = `${label}${yearHtml}`;
    return header;
}

function parseTime(timeStr) {
    if (!timeStr) return 0;
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
    if (!match) return 0;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (match[3]) {
        const pm = match[3].toUpperCase() === 'PM';
        if (pm && h !== 12) h += 12;
        else if (!pm && h === 12) h = 0;
    }
    return h * 60 + m;
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

    upcomingEventsListEl.innerHTML = '';
    pastEventsListEl.innerHTML = '';

    resetColorIndex();

    const upcomingEvents = [];
    const pastEvents = [];

    events.forEach((ev, idx) => {
        const past = isEventPast(ev);
        const color = assignEventColor(past);
        if (past) {
            pastEvents.push({ event: ev, originalIndex: idx, color });
        } else {
            upcomingEvents.push({ event: ev, originalIndex: idx, color });
        }
    });

    // Sort by date then time
    const sortItems = (items, asc) => {
        items.sort((a, b) => {
            const dateComp = asc
                ? (a.event.startDate || '').localeCompare(b.event.startDate || '')
                : (b.event.startDate || '').localeCompare(a.event.startDate || '');
            if (dateComp !== 0) return dateComp;
            return parseTime(a.event.startTime) - parseTime(b.event.startTime);
        });
    };

    sortItems(upcomingEvents, true);
    sortItems(pastEvents, false);

    let lastUpcomingKey = null;
    for (const { event, originalIndex, color } of upcomingEvents) {
        const key = monthKeyFromEvent(event);
        if (key !== lastUpcomingKey) {
            upcomingEventsListEl.appendChild(createMonthSectionHeader(event));
            lastUpcomingKey = key;
        }
        upcomingEventsListEl.appendChild(createCard(event, originalIndex, color, false));
    }

    let lastPastKey = null;
    for (const { event, originalIndex, color } of pastEvents) {
        const key = monthKeyFromEvent(event);
        if (key !== lastPastKey) {
            pastEventsListEl.appendChild(createMonthSectionHeader(event));
            lastPastKey = key;
        }
        pastEventsListEl.appendChild(createCard(event, originalIndex, color, true));
    }

    updateButtonStates();

    return { upcomingCount: upcomingEvents.length, pastCount: pastEvents.length, upcomingEvents, pastEvents };
}

export function scrollToCard(card) {
    const scrollContainer = card.closest('.ruled-list');
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
                    behavior: 'smooth',
                });
            }, 200);
        });
    }
}

export function restoreSelection(selectedIdxs, { resultsEl, updateButtonStates }) {
    if (!selectedIdxs?.length) return null;
    const cards = resultsEl?.querySelectorAll('.event-card');
    let firstSelected = null;
    if (cards) {
        cards.forEach((el) => {
            el.classList.remove('selected');
            el.setAttribute('aria-pressed', 'false');
        });
        selectedIdxs.forEach((i) => {
            const el = resultsEl?.querySelector(`.event-card[data-idx="${i}"]`);
            if (el) {
                el.classList.add('selected');
                el.setAttribute('aria-pressed', 'true');
                if (!firstSelected) firstSelected = el;
            }
        });
    }
    updateButtonStates();
    return firstSelected;
}
