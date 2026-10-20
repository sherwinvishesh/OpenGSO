export const metadata = {
  title: 'Engagement record',
  description: 'A dated record of Aurora Fieldwork engagements, budgets, and outcomes.',
};

export default function ResumePage() {
  return (
    <article>
      <h1>Engagement record</h1>
      <p>
        This page exists so the OpenGSO fidelity checks have something concrete to hold onto: real
        dates, real prices, real percentages. Anything that rewrites this page and changes a number
        has failed.
      </p>

      <h2>Svalbard permafrost array</h2>
      <p>
        Commissioned on <strong>3 March 2024</strong> for a fixed fee of <strong>$12,500</strong>.
        Fourteen boreholes, instrumented to 6 metres, logging every 15 minutes. Data return over the
        first winter was <strong>42%</strong> below our target because two loggers iced over, and we
        refunded 1,800 USD without being asked.
      </p>

      <h2>Vatnajokull glacier survey</h2>
      <p>
        Ran from 11 June 2023 to 29 August 2023 at a cost of 21,400 EUR. We placed 9 ablation stakes
        and recovered all 9. Measured surface lowering averaged 2.3 metres over the season.
      </p>

      <h2>Greenland coastal transect</h2>
      <p>
        Awarded 17 September 2022, delivered 4 February 2023, invoiced at 38,900 USD. The transect
        covered 74 kilometres and produced 1.1 TB of raw imagery.
      </p>

      <h3>Summary table</h3>
      <table>
        <thead>
          <tr>
            <th>Engagement</th>
            <th>Start</th>
            <th>Fee</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Svalbard permafrost array</td>
            <td>3 March 2024</td>
            <td>$12,500</td>
            <td>42% below data-return target</td>
          </tr>
          <tr>
            <td>Vatnajokull glacier survey</td>
            <td>11 June 2023</td>
            <td>21,400 EUR</td>
            <td>9 of 9 stakes recovered</td>
          </tr>
          <tr>
            <td>Greenland coastal transect</td>
            <td>17 September 2022</td>
            <td>38,900 USD</td>
            <td>74 km transect, 1.1 TB imagery</td>
          </tr>
        </tbody>
      </table>

      <h3>Contact</h3>
      <p>
        Write to <a href="/about">the team</a> if you want the full methodology notes for any of the
        engagements above.
      </p>
    </article>
  );
}

