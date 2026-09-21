import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getAboutContent } from "../api";

const mdComponents = {
    strong: ({ node, ...props }: any) => <strong className="markdown-bold" {...props} />,
    em: ({ node, ...props }: any) => <em className="markdown-italic" {...props} />,
    h1: ({ node, ...props }: any) => <h1 className="markdown-h1" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="markdown-h2" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="markdown-ul" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="markdown-ol" {...props} />,
    li: ({ node, ...props }: any) => <li className="markdown-li" {...props} />,
    code: ({ node, ...props }: any) => (
        <pre className="markdown-code-block">
            <code {...props} />
        </pre>
    ),
    // Every link in the about page points off-app — always open in a new tab.
    a: ({ node, ...props }: any) => <a target="_blank" rel="noreferrer" {...props} />,
};

export default function AboutPane() {
    const [content, setContent] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getAboutContent()
            .then((c) => {
                if (cancelled) return;
                setContent(c.content || "");
                setLoaded(true);
            })
            .catch(() => {
                if (!cancelled) { setLoaded(true); setLoadError(true); }
            });
        return () => { cancelled = true; };
    }, []);

    return (
        <div className="about-pane">
            <div className="card conduct-card about-card">
                {!loaded ? null : loadError || !content.trim() ? (
                    <p className="conduct-empty-note">
                        Expected at <code>backend/configs/about.md</code>.
                    </p>
                ) : (
                    <div className="conduct-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                            {content}
                        </ReactMarkdown>
                    </div>
                )}
            </div>
        </div>
    );
}
