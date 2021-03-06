import { validation, ValidationError } from "../src";

describe("number test", () => {
    it("should not get triggered if an empty value was set", async () => {
        await expect(validation.validate(null, "number")).resolves.toBe(true);
    });

    it("should fail - values are not numbers", async () => {
        const values = [NaN, true, [], "asd", "{}", {}, "123.x", "11", "11.3211"];

        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            await expect(validation.validate(value, "number")).rejects.toThrow(ValidationError);
        }
    });

    it("should pass - valid numbers given", async () => {
        await expect(validation.validate(11, "number")).resolves.toBe(true);
        await expect(validation.validate(11.434242, "number")).resolves.toBe(true);
    });
});
