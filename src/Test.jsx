import { useCallback, useState } from "react";
import Child from "./Child"

const Test = () => {
    console.log("parent called");

    const [count, setCount] = useState(0);

    // const increment = useCallback(() => {
    //     console.log("callback called", count);
    // }, []);


    const increment = useCallback(() => {
        console.log("callback called");
    }, []);

    return (
        <div>
            Count: {count}
            <Child increment={increment} />

            <button onClick={() => setCount(count + 1)}>Increment</button>
        </div>
    )
}

export default Test;