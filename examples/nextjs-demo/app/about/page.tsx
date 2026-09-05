export const metadata = {
  title: 'About Aurora Fieldwork',
  description: 'Who runs Aurora Fieldwork, how we work, and what we will not do.',
};

export default function AboutPage() {
  return (
    <article>
      <h1>About</h1>
      <p>
        Aurora Fieldwork is Ingrid Halle and Petter Roald. Ingrid spent nine years at the Norwegian
        Polar Institute before leaving to do fieldwork full time. Petter is an instrumentation
        engineer who has built loggers for high-latitude deployments since 2011.
      </p>
      <h2>How we work</h2>
      <ol>
        <li>A scoping call, always free, usually about forty minutes.</li>
        <li>A written survey plan with a fixed price and a named weather contingency window.</li>
        <li>Deployment, then a retrieval trip in the following season.</li>
        <li>Raw data plus a cleaned dataset, delivered as CSV and NetCDF.</li>
      </ol>
      <h2>What we will not do</h2>
      <blockquote>
        We do not take work that requires flying a helicopter into a closed weather window. There is
        no deadline worth that, and we have turned down three contracts over it.
      </blockquote>
      <h2>Where we are</h2>
      <p>
        Our workshop is in Tromso, Norway. Most of the year one of us is somewhere else, so email is
        far better than a phone call.
      </p>
    </article>
  );
}
