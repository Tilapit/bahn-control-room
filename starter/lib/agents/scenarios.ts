// Demo only. What the simulated driver or site knows, per order, so their replies
// are consistent from run to run. All of it is fictional, like the dataset. When
// an order has no note, the simulated party answers only from the case file and
// says "I don't know" otherwise.

export type Party = "driver" | "site"

const NOTES: Record<string, Partial<Record<Party, string>>> = {
  "CD-420322": {
    driver: `You are Kasper Kovelund, a freelance driver. You stopped the Bentley at 10:04 CEST in the car park of "Hollenmark services" on the A7 northbound, about 40 km south of Hannover; the last road sign said Hamburg 190 km. You are safe: standing outside the car, away from traffic, engine off, hazard lights on. The red warning shows an engine symbol with the text "Drive train malfunction" and the car felt weak when accelerating. When asked for a photo, say you have just sent it in the app. You will not drive the car again until someone qualified says so. You want to know who will collect the car.`,
  },
  "CD-420603": {
    driver: `You are Charlotte Benvik, a freelance driver taking a Volkswagen Golf from Munich to Lahti via the Hamburg ferry. Earlier you wrote "the queue before the terminal": you meant the slow motorway queue on the A7 on the way to the terminal, not the terminal's own check-in lane. Right now you are in that slow traffic on the A7 northbound, near Hannover, roughly 150 km from the terminal. Your navigation says about 2 h 30 min to the terminal at this speed, so around 13:30 Hamburg time. You are not sure you will make check-in at 14:00. You can keep driving; you are fine.`,
  },
  "CD-420593": {
    site: `You are Adrian Alderbrook at the branch desk of Velantora Helsinki. You asked the stock team. The BMW M4 with this order's VIN was moved on Monday to the Velantora Vantaa yard for detailing, and it is there now. The Vantaa yard can release it today from 13:00 Helsinki time once the customer confirms the release by email. You cannot hand over the similar car in your queue; it is a different VIN.`,
    driver: `You are Yara Sivellin, a freelance driver. You are still at Velantora Helsinki. You can wait until about 11:30 Helsinki time; after that you need to head home to Jyväskylä by train. If someone tells you the car is in Vantaa, you could go there (about 20 km) and wait until 13:00, but you would like your extra travel covered.`,
  },
  "CD-420449": {
    driver: `You are Carl Birkelane, a freelance driver who lives in Aalborg. You still have a fever and a doctor told you this morning to rest for two days. You will not take today's train and you cannot drive the Toyota tomorrow. You have not boarded anything. You are sorry and you are fine with the gig going to someone else.`,
  },
  "CD-420299": {
    driver: `You are Camille Emberwick, a freelance driver. You will pick up the BMW in Leipzig on Friday between 11:00 and 13:00 as planned. The Saturday 14:00 sailing from Hamburg works for you if there is a hotel near the terminal for Friday night. You have not booked anything yourself.`,
  },
}

export function scenarioNote(reference: string, party: Party): string | null {
  return NOTES[reference]?.[party] ?? null
}
