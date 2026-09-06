import { Link } from "react-router";
import { Layout } from "../components/Layout";

export function NotFoundPage() { return <Layout><h1>Page not found</h1><p>The address may be incomplete.</p><Link to="/">Return home</Link></Layout>; }
