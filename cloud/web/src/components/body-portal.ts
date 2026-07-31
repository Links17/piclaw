import { render, useEffect, useLayoutEffect, useState } from '../vendor/preact-htm.js';

export function BodyPortal({ children, className = '' }) {
    const [host, setHost] = useState(null);

    useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const nextHost = document.createElement('div');
        // Apply the portal class before insertion so overlay stacking rules are
        // active on the first paint; otherwise fixed compose/editor chrome can
        // briefly render above modal backdrops until the follow-up effect runs.
        nextHost.className = className || '';
        document.body.appendChild(nextHost);
        setHost(nextHost);
        return () => {
            try {
                render(null, nextHost);
            } finally {
                nextHost.remove();
            }
        };
    }, []);

    useEffect(() => {
        if (!host) return undefined;
        host.className = className || '';
        return undefined;
    }, [className, host]);

    useLayoutEffect(() => {
        if (!host) return undefined;
        render(children, host);
        return undefined;
    }, [children, host]);

    return null;
}
