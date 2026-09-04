import { describe, expect, it } from "vitest";
import { displayTeamName } from "../src/web/team-display";

describe("team display names", () => {
  it("uses concise school names for NCAA football teams", () => {
    expect(displayTeamName("ncaaf", "Texas Longhorns")).toBe("Texas");
    expect(displayTeamName("ncaaf", "Miami (OH) RedHawks")).toBe("Miami (OH)");
    expect(displayTeamName("ncaaf", "Notre Dame Fighting Irish")).toBe("Notre Dame");
    expect(displayTeamName("ncaaf", "UT Rio Grande Valley Vaqueros")).toBe("UT Rio Grande Valley");
    expect(displayTeamName("ncaaf", "Buffalo Bulls")).toBe("Buffalo");
    expect(displayTeamName("ncaaf", "Delaware Blue Hens")).toBe("Delaware");
    expect(displayTeamName("ncaaf", "Colorado Buffaloes")).toBe("Colorado");
    expect(displayTeamName("ncaaf", "West Georgia Wolves")).toBe("West Georgia");
    expect(displayTeamName("ncaaf", "Kennesaw State Owls")).toBe("Kennesaw State");
    expect(displayTeamName("ncaaf", "UMass Minutemen")).toBe("UMass");
    expect(displayTeamName("ncaaf", "Illinois Fighting Illini")).toBe("Illinois");
    expect(displayTeamName("ncaaf", "UAB Blazers")).toBe("UAB");
    expect(displayTeamName("ncaaf", "Minnesota Golden Gophers")).toBe("Minnesota");
    expect(displayTeamName("ncaaf", "Eastern Illinois Panthers")).toBe("Eastern Illinois");
  });

  it("keeps unknown NCAA and all NFL names unchanged", () => {
    expect(displayTeamName("ncaaf", "Future State Narwhals")).toBe("Future State Narwhals");
    expect(displayTeamName("nfl", "Kansas City Chiefs")).toBe("Kansas City Chiefs");
  });
});
